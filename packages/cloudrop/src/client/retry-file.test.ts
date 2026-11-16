// Contract: spec §4.7 and plan B's rulings Q8, Q9, Q12 to Q15 through the real client: retry() of a failed file reuses
// its ticket when a new attempt with it can succeed, re-sending only the parts that had not landed and keeping the key
// and the bytes counted; it calls /complete first when one may have succeeded, whatever the clock says; after a
// refusal only a new upload fixes, or with an expired ticket, it asks /upload for a new ticket (new key, bytes from 0),
// one /upload for every file of job.retry(). A file that has not failed is waited for or left as it is, and `done`
// keeps each file's first outcome. Oracle: the requests the fixture saw, the keys the server issued, and the objects
// the fake bucket holds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type FileOutcome } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route, unauthorized } from "../server/route.ts";
import { clientFixture, type Fault, type FaultCall } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });
const members = route({
  accept: "*/*",
  maxSize: "100MB",
  authorize: ({ request }) => (request.headers.get("x-user") ? {} : unauthorized("Sign in to upload files.")),
});

/** Every ticket /upload answered, in order: its key, token and expiry. */
interface Issued {
  key: string;
  token: string;
  expiresAt: string;
}

/** A client on the fake bucket; /upload is forwarded and its tickets kept in `issued`, `fault` answers the rest. */
function setup(fault: Fault = () => undefined) {
  const issued: Issued[] = [];
  const fixture = clientFixture(
    { files, members },
    {
      multipartThreshold: "8MB",
      fault: async (call) => {
        if (call.label !== "POST /upload") return fault(call);
        const answer = (await fault(call)) ?? (await call.forward(call.init));
        issued.push(...((await answer.clone().json()).files ?? []));
        return answer;
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  /** The requests sent from now on. */
  const from = () => {
    const start = fixture.requests.length;
    return () => fixture.requests.slice(start);
  };
  return { fixture, issued, client, from };
}

const fileOf = (size: number, name = "a.bin") =>
  new File([offsetBytes(size)], name, { type: "application/octet-stream" });
/** Three parts of the 8 MiB plan: 8 MiB, 8 MiB and 5 bytes. */
const threeParts = () => fileOf(16 * MiB + 5);
const twoParts = () => fileOf(8 * MiB + 5);
const storageDown = () => errorResponse(500, "InternalError", "We encountered an internal error. Please try again.");
const keyOf = (outcome: FileOutcome<unknown> | undefined) =>
  outcome?.status === "done" ? outcome.result.file.key : null;
/** /complete reached the server, which finished the file, and its answer was lost on the way back. */
const lostAnswer = (call: FaultCall) =>
  call.forward(call.init).then(() => Promise.reject(new TypeError("Failed to fetch")));

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retry with the file's ticket", () => {
  it("re-sends only the part that ran out of attempts and completes under the same key, keeping the bytes", async () => {
    let failing = true;
    const { fixture, issued, client, from } = setup(({ label }) =>
      failing && label === "PUT part 3" ? storageDown() : undefined,
    );
    const job = client.start("files", threeParts());
    const first = await job.done;
    failing = false;
    const sent = from();
    const retried = job.files[0]?.retry();
    const bytesAtRetry = job.getSnapshot().files[0]?.bytes;
    const outcome = await retried;
    const key = keyOf(outcome);
    expect({
      first: first.error?.code,
      bytesAtRetry,
      sent: sent(),
      sameKey: key === issued[0]?.key,
      stored: key && (await fixture.server.storage.head(key)).data?.size,
    }).toEqual({
      first: "STORAGE_ERROR",
      bytesAtRetry: 16 * MiB,
      sent: ["PUT part 3", "POST /complete"],
      sameKey: true,
      stored: 16 * MiB + 5,
    });
  });

  it("repairs again a file that failed with PARTS_MISSING after its two repair rounds (I5)", async () => {
    // The bucket says it stored part 2 and keeps nothing: on the first send, on both repairs and on the retry's send.
    const { client, from } = setup(({ label, nth }) =>
      label === "PUT part 2" && nth <= 4 ? new Response(null, { status: 200 }) : undefined,
    );
    const job = client.start("files", twoParts());
    const first = await job.done;
    const sent = from();
    const outcome = await job.files[0]?.retry();
    expect({ first: first.error?.code, sent: sent(), outcome: outcome?.status }).toEqual({
      first: "PARTS_MISSING",
      // The retry's own repair round: the retry starts counting repairs from 0 again.
      sent: ["PUT part 2", "POST /complete", "PUT part 2", "POST /complete"],
      outcome: "done",
    });
  });

  it.each([
    { name: "a live ticket", late: false, outcome: ["done", undefined] },
    // The server's own verdict on the expired token; asking for a new one could store the file twice (I6).
    { name: "an expired ticket", late: true, outcome: ["failed", "UPLOAD_EXPIRED"] },
  ])("sends /complete first when one may have succeeded, with $name", async (row) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let dropping = true;
    const { client, issued, from } = setup((call) =>
      dropping && call.label === "POST /complete" ? lostAnswer(call) : undefined,
    );
    const job = client.start("files", fileOf(1000));
    const first = await job.done;
    dropping = false;
    if (row.late) vi.setSystemTime(Date.parse(issued[0]?.expiresAt ?? "") + 1000);
    const sent = from();
    const outcome = await job.files[0]?.retry();
    expect({
      first: first.error?.code,
      sent: sent(),
      outcome: [outcome?.status, outcome?.status === "done" ? undefined : outcome?.error.code],
    }).toEqual({ first: "NETWORK_ERROR", sent: ["POST /complete"], outcome: row.outcome });
  });
});

describe("retry with a new ticket", () => {
  it.each([
    { name: "the bucket refused the part's signature", status: 403, late: false, code: "UPLOAD_REJECTED" },
    { name: "the ticket expired after the part ran out of attempts", status: 500, late: true, code: "STORAGE_ERROR" },
  ])("asks /upload again and starts over under a new key: $name", async (row) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let failing = true;
    const { client, issued, from } = setup(({ label }) => {
      if (!failing || label !== "PUT part 2") return undefined;
      return row.status === 403 ? errorResponse(403, "SignatureDoesNotMatch", "Signature mismatch.") : storageDown();
    });
    const job = client.start("files", twoParts());
    const first = await job.done;
    const bytesBefore = job.getSnapshot().files[0]?.bytes;
    failing = false;
    if (row.late) vi.setSystemTime(Date.parse(issued[0]?.expiresAt ?? "") + 1000);
    const sent = from();
    const retried = job.files[0]?.retry();
    const bytesAtRetry = job.getSnapshot().files[0]?.bytes;
    const key = keyOf(await retried);
    expect({
      first: first.error?.code,
      bytes: [bytesBefore, bytesAtRetry],
      sent: sent().sort(),
      newKey: key !== null && key === issued[1]?.key && key !== issued[0]?.key,
    }).toEqual({
      first: row.code,
      // A new upload has stored nothing: its bytes start from 0 (Q14).
      bytes: [8 * MiB, 0],
      sent: ["POST /complete", "POST /upload", "PUT part 1", "PUT part 2"],
      newKey: true,
    });
  });

  it("asks one /upload for every file of a job the server refused, once the user signs in (Q12)", async () => {
    let signedIn = false;
    const { client, from } = setup(({ label, init, forward }) =>
      signedIn && label === "POST /upload"
        ? forward({ ...init, headers: { ...init.headers, "x-user": "ada" } })
        : undefined,
    );
    const job = client.start("members", [fileOf(1000, "a.bin"), fileOf(2000, "b.bin")]);
    const first = await job.done;
    signedIn = true;
    const sent = from();
    const { data, error } = await job.retry();
    expect({
      first: [first.data, first.error?.code],
      sent: sent().sort(),
      files: data?.files.map((outcome) => [outcome.name, outcome.status]),
      error,
    }).toEqual({
      first: [null, "UNAUTHORIZED"],
      sent: ["POST /complete", "POST /complete", "POST /upload", "PUT object", "PUT object"],
      files: [
        ["a.bin", "done"],
        ["b.bin", "done"],
      ],
      error: null,
    });
  });
});

describe("retry of a file that has not failed", () => {
  it.each([
    { name: "done", cancel: false, status: "done" },
    { name: "aborted", cancel: true, status: "aborted" },
  ])("resolves at once with the outcome of a $name file and sends nothing", async (row) => {
    const { client, from } = setup();
    const job = client.start("files", fileOf(1000));
    if (row.cancel) job.files[0]?.abort();
    const { data } = await job.done;
    const sent = from();
    const outcome = await job.files[0]?.retry();
    expect({ outcome, status: outcome?.status, sent: sent() }).toEqual({
      outcome: data?.files[0],
      status: row.status,
      sent: [],
    });
  });

  it("waits for an uploading file to settle and resolves with that outcome, sending nothing more", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atPut = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { fixture, client } = setup(async ({ label }) => {
      if (label !== "PUT object") return undefined;
      reached();
      await held;
      return undefined;
    });
    const job = client.start("files", fileOf(1000));
    await atPut;
    const status = job.getSnapshot().files[0]?.status;
    const retried = job.files[0]?.retry();
    release();
    const [outcome, { data }] = await Promise.all([retried, job.done]);
    expect({ status, outcome, requests: fixture.requests }).toEqual({
      status: "uploading",
      outcome: data?.files[0],
      requests: ["POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("answers job.retry() of a job refused for its arguments as `done` did", async () => {
    const job = createCloudropClient({ fetch: () => Promise.reject(new Error("never sent")) }).start("files", []);
    const [done, retried] = await Promise.all([job.done, job.retry()]);
    expect({ retried, code: retried.error?.code }).toEqual({ retried: done, code: "INVALID_INPUT" });
  });
});

describe("done", () => {
  it("reports the first outcome of a file retried while another still runs (Q13)", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failing = true;
    const { client } = setup(async ({ label, init }) => {
      if (label !== "PUT object") return undefined;
      if ((init.body as Blob).size === 2000) await held;
      return failing ? storageDown() : undefined;
    });
    const job = client.start("files", [fileOf(1000, "a.bin"), fileOf(2000, "b.bin")]);
    const [a] = job.files;
    // a.bin fails while b.bin's PUT is held; its retry then succeeds before b.bin ends.
    const firstFailure = new Promise<void>((resolve) => {
      const stop = job.subscribe(() => {
        if (job.getSnapshot().files[0]?.status !== "failed") return;
        stop();
        resolve();
      });
    });
    await firstFailure;
    failing = false;
    const retried = await a?.retry();
    release();
    const { data, error } = await job.done;
    expect({
      retried: retried?.status,
      done: data?.files.map((outcome) => outcome.status),
      error: [error?.code, error?.file?.name],
    }).toEqual({ retried: "done", done: ["failed", "done"], error: ["STORAGE_ERROR", "a.bin"] });
  });
});
