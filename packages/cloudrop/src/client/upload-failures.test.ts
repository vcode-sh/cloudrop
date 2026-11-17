// Contract: decisions S10 to S14 through the real client and server: bucket answers renewed, retried or refused, a
// PARTS_MISSING repair bounded at two rounds, the retry budget, and a cancel that tells the server unless a /complete
// may have finished the file (S14 as corrected, M3-H16). Oracle: the measured R2 answers named in S10, sent as the fake
// sends them; the request list; and the object the fake bucket holds afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { Result } from "../errors.ts";
import { MiB } from "../rules.ts";
import { route, unauthorized } from "../server/route.ts";
import {
  clientFixture,
  type Fault,
  type FaultCall,
  lostPart,
  storageBusy,
  unfinished,
} from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import { albumSchema } from "../testing/upload-fixture.ts";

const albums = route(
  {
    accept: ["image/png", "application/octet-stream"],
    maxSize: "100MB",
    metadata: albumSchema,
    authorize: ({ request }) => {
      const userId = request.headers.get("x-user");
      return userId ? { userId } : unauthorized("Sign in to upload to an album.");
    },
  },
  {
    prefix: ({ userId }) => `users/${userId}`,
    onComplete: ({ userId, file, metadata }) => ({ owner: userId, bytes: file.size, albumId: metadata.albumId }),
  },
);

function setup(fault: Fault) {
  const fixture = clientFixture({ albums }, { multipartThreshold: "8MB", appHeaders: { "x-user": "42" }, fault });
  return { fixture, client: createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch }) };
}

const metadata = { albumId: "a1" };
const bytes = offsetBytes(8 * MiB + 5);
const pic = () => new File([offsetBytes(1000)], "pic.png", { type: "image/png" });
const video = () => new File([bytes], "video.bin", { type: "application/octet-stream" });
const errorOf = ({ error }: Result<unknown>) => ({
  code: error?.code,
  message: error?.message,
  retryable: error?.retryable,
});
const routeData = { owner: "42", bytes: 1000, albumId: "a1" };

/** Answers POST /complete with `complete`, and remembers the ticket's key from the real /upload answer. */
function atComplete(complete: (call: FaultCall) => Promise<Response | undefined> | Response | undefined) {
  const ticket = { key: "" };
  const fault: Fault = async (call) => {
    if (call.label === "POST /complete") return complete(call);
    if (call.label !== "POST /upload") return undefined;
    const answer = await call.forward(call.init);
    ticket.key = (await answer.clone().json()).files[0].key;
    return answer;
  };
  return { fault, ticket };
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("upload, when the bucket answers badly", () => {
  it("renews a URL the bucket calls expired and finishes", async () => {
    const { fixture, client } = setup(({ label, nth }) =>
      label === "PUT object" && nth === 1 ? errorResponse(403, "ExpiredRequest", "Request has expired") : undefined,
    );
    const { error } = await client.upload("albums", pic(), { metadata });
    expect({ error, requests: fixture.requests }).toEqual({
      error: null,
      requests: ["POST /upload", "PUT object", "POST /sign", "PUT object", "POST /complete"],
    });
  });

  it("renews a URL about to expire before sending it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fixture, client } = setup(async ({ label, init, forward }) => {
      if (label !== "POST /upload") return undefined;
      const answer = await forward(init);
      // The 15-minute URL now has 29 s left, under the one-minute margin (S11).
      vi.setSystemTime(Date.now() + (14 * 60 + 31) * 1000);
      return answer;
    });
    const { error } = await client.upload("albums", pic(), { metadata });
    expect({ error, requests: fixture.requests }).toEqual({
      error: null,
      requests: ["POST /upload", "POST /sign", "PUT object", "POST /complete"],
    });
  });

  it("retries a busy bucket without renewing", async () => {
    const { fixture, client } = setup(({ label, nth }) =>
      label === "PUT object" && nth === 1
        ? errorResponse(503, "ServiceUnavailable", "Reduce your request rate.")
        : undefined,
    );
    const { error } = await client.upload("albums", pic(), { metadata });
    expect({ error, requests: fixture.requests }).toEqual({
      error: null,
      requests: ["POST /upload", "PUT object", "PUT object", "POST /complete"],
    });
  });

  it("fails a file whose bytes do not match the signature, once", async () => {
    let aborted = Promise.resolve();
    const { fixture, client } = setup(({ label, init, forward }) => {
      if (label === "PUT object") {
        return forward({
          ...init,
          headers: { ...(init.headers as Record<string, string>), "content-type": "text/html" },
        });
      }
      if (label !== "POST /abort") return undefined;
      // Kept so the test ends only after the background /abort has settled.
      const answer = forward(init);
      aborted = answer.then(() => undefined);
      return answer;
    });
    const result = await client.upload("albums", pic(), { metadata });
    await aborted;
    expect({ error: errorOf(result), requests: fixture.requests }).toEqual({
      error: {
        code: "UPLOAD_REJECTED",
        message:
          "The storage service refused the file because its bytes do not match what the server signed. Pick the file again and start a new upload.",
        retryable: false,
      },
      // The bucket stored nothing, so the /abort that follows the failure (ruling S-18) deletes nothing.
      requests: ["POST /upload", "PUT object", "POST /abort"],
    });
  });
});

describe("upload, when /complete finds parts missing", () => {
  it("re-sends the parts /complete names as missing", async () => {
    const { fixture, client } = setup(({ label, nth }) =>
      label === "PUT part 2" && nth === 1 ? lostPart() : undefined,
    );
    const { data, error } = await client.upload("albums", video(), { metadata });
    const boundary = await fixture.server.storage.getRange(data?.file.key ?? "", 8 * MiB - 2, 8 * MiB + 1);
    // The ticket's URL for part 2 is still valid, so the repair needs no /sign.
    expect({ error, requests: fixture.requests, boundary: boundary.data }).toEqual({
      error: null,
      requests: ["POST /upload", "PUT part 1", "PUT part 2", "POST /complete", "PUT part 2", "POST /complete"],
      boundary: bytes.slice(8 * MiB - 2, 8 * MiB + 2),
    });
  });

  it("gives up after two repair rounds", async () => {
    const { fixture, client } = setup(({ label }) => (label === "PUT part 2" ? lostPart() : undefined));
    const result = await client.upload("albums", video(), { metadata });
    expect({
      error: errorOf(result),
      parts: result.error?.parts,
      completes: fixture.requests.filter((label) => label === "POST /complete").length,
    }).toEqual({
      error: {
        code: "PARTS_MISSING",
        message: "1 of 2 parts are missing or have the wrong size. Upload them again, then complete the upload.",
        retryable: false,
      },
      parts: [2],
      completes: 3,
    });
  });
});

describe("upload, when it is cancelled", () => {
  const cancelled = {
    code: "ABORTED",
    message: "The upload was cancelled. Start it again to upload the file.",
    retryable: false,
  };

  it("cancels a multipart upload and tells the server", async () => {
    const controller = new AbortController();
    const { fixture, client } = setup(({ label }) => {
      if (label === "PUT part 1") controller.abort();
      return undefined;
    });
    const result = await client.upload("albums", video(), { metadata, signal: controller.signal });
    expect({
      error: errorOf(result),
      last: fixture.requests.at(-1),
      pending: fixture.server.fake.pendingUploads(),
    }).toEqual({ error: cancelled, last: "POST /abort", pending: 0 });
  });

  it("keeps a file whose /complete finished while the upload was cancelled", async () => {
    const controller = new AbortController();
    const { fault, ticket } = atComplete(async ({ init, forward }) => {
      const answer = await forward(init);
      controller.abort();
      return answer;
    });
    const { fixture, client } = setup(fault);
    const result = await client.upload("albums", pic(), { metadata, signal: controller.signal });
    expect({
      error: result.error,
      data: result.data?.data,
      requests: fixture.requests,
      size: (await fixture.server.storage.head(ticket.key)).data?.size,
    }).toEqual({
      error: null,
      data: routeData,
      requests: ["POST /upload", "PUT object", "POST /complete"],
      size: 1000,
    });
  });

  it("keeps a file whose /complete answer was lost to a cancel", async () => {
    const controller = new AbortController();
    const { fault, ticket } = atComplete(async ({ init, forward }) => {
      await forward(init);
      controller.abort();
      throw new TypeError("Failed to fetch");
    });
    const { fixture, client } = setup(fault);
    const result = await client.upload("albums", pic(), { metadata, signal: controller.signal });
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      size: (await fixture.server.storage.head(ticket.key)).data?.size,
    }).toEqual({ error: cancelled, requests: ["POST /upload", "PUT object", "POST /complete"], size: 1000 });
  });

  it("cleans up after a cancel during a /complete the server refused", async () => {
    const controller = new AbortController();
    const { fault, ticket } = atComplete(() => {
      controller.abort();
      return storageBusy();
    });
    const { fixture, client } = setup(fault);
    const result = await client.upload("albums", pic(), { metadata, signal: controller.signal });
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      head: (await fixture.server.storage.head(ticket.key)).data,
    }).toEqual({
      error: cancelled,
      requests: ["POST /upload", "PUT object", "POST /complete", "POST /abort"],
      head: null,
    });
  });

  it("keeps a file an earlier /complete may have finished after a later one was refused", async () => {
    const controller = new AbortController();
    const { fault, ticket } = atComplete(async ({ nth, init, forward }) => {
      if (nth === 1) {
        await forward(init);
        return unfinished();
      }
      controller.abort();
      return storageBusy();
    });
    const { fixture, client } = setup(fault);
    const result = await client.upload("albums", pic(), { metadata, signal: controller.signal });
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      size: (await fixture.server.storage.head(ticket.key)).data?.size,
    }).toEqual({
      error: cancelled,
      requests: ["POST /upload", "PUT object", "POST /complete", "POST /complete"],
      size: 1000,
    });
  });

  // Round 0's first /complete gets no answer and its retry answers PARTS_MISSING [2], which proves no /complete has
  // finished the file (ruling S-9): a cancel in the repair round that follows tells the server.
  // The repair round sends PUT part 2 for the second time, then POST /complete for the third; the cancel lands in one.
  const cancelInRepair =
    (cancelAt: { label: string; nth: number }, controller: AbortController): Fault =>
    async ({ label, nth, init, forward }) => {
      if (label === "PUT part 2" && nth === 1) return lostPart();
      if (label === "POST /complete" && nth === 1) throw new TypeError("Failed to fetch");
      if (label !== cancelAt.label || nth !== cancelAt.nth) return undefined;
      // The refused /complete never reaches the server, so the multipart upload stays open for /abort to remove.
      const answer = label === "POST /complete" ? storageBusy() : await forward(init);
      controller.abort();
      return answer;
    };

  it("tells the server after a cancel during a repair PUT, though an earlier /complete got no answer", async () => {
    const controller = new AbortController();
    const { fixture, client } = setup(cancelInRepair({ label: "PUT part 2", nth: 2 }, controller));
    const result = await client.upload("albums", video(), { metadata, signal: controller.signal });
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      pending: fixture.server.fake.pendingUploads(),
    }).toEqual({
      error: cancelled,
      requests: [
        "POST /upload",
        "PUT part 1",
        "PUT part 2",
        "POST /complete",
        "POST /complete",
        "PUT part 2",
        "POST /abort",
      ],
      pending: 0,
    });
  });

  it("tells the server after a cancel during a repair /complete the server refused", async () => {
    const controller = new AbortController();
    const { fixture, client } = setup(cancelInRepair({ label: "POST /complete", nth: 3 }, controller));
    const result = await client.upload("albums", video(), { metadata, signal: controller.signal });
    expect({
      error: errorOf(result),
      requests: fixture.requests,
      pending: fixture.server.fake.pendingUploads(),
    }).toEqual({
      error: cancelled,
      requests: [
        "POST /upload",
        "PUT part 1",
        "PUT part 2",
        "POST /complete",
        "POST /complete",
        "PUT part 2",
        "POST /complete",
        "POST /abort",
      ],
      pending: 0,
    });
  });

  it("ends aborted, never uploading again, after a cancel during a /complete that finds parts missing (M4-F4)", async () => {
    const controller = new AbortController();
    const { fixture, client } = setup(async ({ label, nth, init, forward }) => {
      if (label === "PUT part 2" && nth === 1) return lostPart();
      if (label !== "POST /complete") return undefined;
      // The server's real answer, PARTS_MISSING [2], arrives after the cancel.
      const answer = await forward(init);
      controller.abort();
      return answer;
    });
    const job = client.start("albums", video(), { metadata, signal: controller.signal });
    // Each status the page was shown, once per change.
    const shown: string[] = [];
    job.subscribe(() => {
      const status = job.getSnapshot().files[0]?.status ?? "";
      if (shown.at(-1) !== status) shown.push(status);
    });
    await job.done;
    expect({ shown, requests: fixture.requests, pending: fixture.server.fake.pendingUploads() }).toEqual({
      shown: ["uploading", "completing", "aborted"],
      requests: ["POST /upload", "PUT part 1", "PUT part 2", "POST /complete", "POST /abort"],
      pending: 0,
    });
  });

  it("starts nothing for a signal that has already fired", async () => {
    const { fixture, client } = setup(() => undefined);
    const result = await client.upload("albums", pic(), { metadata, signal: AbortSignal.abort() });
    expect({ error: errorOf(result), requests: fixture.requests }).toEqual({ error: cancelled, requests: [] });
  });
});

describe("upload, when the server cannot be reached", () => {
  it("reports an unreachable server after six tries", async () => {
    const { fixture, client } = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await client.upload("albums", pic(), { metadata });
    expect({ error: errorOf(result), requests: fixture.requests }).toEqual({
      error: {
        code: "NETWORK_ERROR",
        message: "The upload server could not be reached. Check the connection, then try again.",
        retryable: true,
      },
      requests: Array(6).fill("POST /upload"),
    });
  });
});
