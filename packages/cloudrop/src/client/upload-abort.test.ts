// Contract: ruling S-18 (decision M3-S15): after /upload, a file that fails for a reason other than a cancel sends
// /abort exactly when no /complete attempt may have finished it, so a definite failure leaves no object or open
// multipart upload behind and a doubtful one never deletes a file that may be recorded; upload() answers the failure
// without waiting for that /abort. Oracle: the objects and open uploads the fake bucket holds once the /abort the
// fixture forwarded has settled, and the requests the fixture saw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { Result } from "../errors.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, storageBusy, unfinished } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: allowAnyone });

/**
 * A client on the fake bucket. `fault` answers every request but /upload and /abort; /upload is forwarded and its key
 * kept, and /abort is forwarded and its settling kept in `aborted`, so a test can wait for the background /abort.
 */
function setup(fault: Fault) {
  const seen = { key: "", aborted: Promise.resolve() };
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: async (call) => {
        if (call.label === "POST /abort") {
          const answer = call.forward(call.init);
          seen.aborted = answer.then(() => undefined);
          return answer;
        }
        if (call.label !== "POST /upload") return fault(call);
        const answer = await call.forward(call.init);
        seen.key = (await answer.clone().json()).files[0].key;
        return answer;
      },
    },
  );
  return { fixture, seen, client: createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch }) };
}

const small = () => new File([offsetBytes(1000)], "small.bin", { type: "application/octet-stream" });
const large = () => new File([offsetBytes(8 * MiB + 5)], "large.bin", { type: "application/octet-stream" });
const errorOf = ({ error }: Result<unknown>) => ({ code: error?.code, retryable: error?.retryable });
const sixCompletes = Array(6).fill("POST /complete");

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("upload, when it fails after /upload", () => {
  it("removes a stored file whose /complete the server refused every time", async () => {
    const { fixture, seen, client } = setup(({ label }) => (label === "POST /complete" ? storageBusy() : undefined));
    const result = await client.upload("files", small());
    await seen.aborted;
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      head: (await fixture.server.storage.head(seen.key)).data,
    }).toEqual({
      error: { code: "RATE_LIMITED", retryable: true },
      requests: ["POST /upload", "PUT object", ...sixCompletes, "POST /abort"],
      head: null,
    });
  });

  it("removes an object the bucket stored though it answered with an error", async () => {
    // The bytes landed, then a refusal reached the page: the object exists, and no /complete was sent.
    const { fixture, seen, client } = setup(async ({ label, init, forward }) => {
      if (label !== "PUT object") return undefined;
      await forward(init);
      return errorResponse(400, "BadRequest", "Rejected after storing.");
    });
    const result = await client.upload("files", small());
    await seen.aborted;
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      head: (await fixture.server.storage.head(seen.key)).data,
    }).toEqual({
      error: { code: "UPLOAD_REJECTED", retryable: false },
      requests: ["POST /upload", "PUT object", "POST /abort"],
      head: null,
    });
  });

  it.each([
    {
      name: "got no answer",
      first: async (init: RequestInit, forward: (init: RequestInit) => Promise<Response>) => {
        await forward(init);
        throw new TypeError("Failed to fetch");
      },
    },
    {
      name: "answered SERVER_ERROR",
      first: async (init: RequestInit, forward: (init: RequestInit) => Promise<Response>) => {
        await forward(init);
        return unfinished();
      },
    },
  ])("keeps a failed file whose first /complete $name", async ({ first }) => {
    const { fixture, seen, client } = setup(({ label, nth, init, forward }) => {
      if (label !== "POST /complete") return undefined;
      return nth === 1 ? first(init, forward) : storageBusy();
    });
    const result = await client.upload("files", small());
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      size: (await fixture.server.storage.head(seen.key)).data?.size,
    }).toEqual({
      error: { code: "RATE_LIMITED", retryable: true },
      requests: ["POST /upload", "PUT object", ...sixCompletes],
      size: 1000,
    });
  });

  it("aborts the multipart upload of a file whose part was refused", async () => {
    const { fixture, seen, client } = setup(({ label }) =>
      label === "PUT part 2" ? errorResponse(400, "BadRequest", "Rejected.") : undefined,
    );
    const result = await client.upload("files", large());
    await seen.aborted;
    expect({
      error: errorOf(result),
      last: fixture.requests.at(-1),
      completes: fixture.requests.filter((label) => label === "POST /complete").length,
      pending: fixture.server.fake.pendingUploads(),
    }).toEqual({ error: { code: "UPLOAD_REJECTED", retryable: false }, last: "POST /abort", completes: 0, pending: 0 });
  });

  it("answers without waiting for the /abort", async () => {
    // The /abort never answers here: upload() resolving at all is the proof that it did not wait.
    let release = () => {};
    const held = new Promise<Response>((resolve) => {
      release = () => resolve(Response.json({ id: "held" }));
    });
    const answers: Record<string, () => Response | Promise<Response>> = {
      "POST /complete": storageBusy,
      "POST /abort": () => held,
    };
    const fixture = clientFixture({ files }, { fault: ({ label }) => answers[label]?.() });
    const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
    const result = await client.upload("files", small());
    release();
    expect({ error: errorOf(result), last: fixture.requests.at(-1) }).toEqual({
      error: { code: "RATE_LIMITED", retryable: true },
      last: "POST /abort",
    });
  });
});
