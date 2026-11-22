// Contract: spec 1.0 §2d (M12-E7, M12-R40): in a browser on the XHR path, a single PUT or a part fails at once with
// BUCKET_BLOCKED, not retryable, when two consecutive attempts ended in XHR onerror without upload progress and a /sign
// of that part answered 2xx between them while the page is online; any other failure keeps the old budget of six
// attempts and NETWORK_ERROR. BUCKET_BLOCKED keeps the ticket, so retry() sends only what had not landed.
// Oracle: the spec's five conditions; the six attempts are MAX_ATTEMPTS (client/retry.ts); the requests the fake XHR
// and the fixture saw, in order.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, storageBusy } from "../testing/client-fixture.ts";
import { fakeXhr, type XhrCall } from "../testing/fake-xhr.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

/** How the bucket ends a PUT: `nth` counts the file's PUTs from 1. */
type End = (call: XhrCall, nth: number) => unknown;

/** An online browser's navigator. */
const BROWSER = { onLine: true };

/**
 * A client in a runtime with `navigator` (a browser by default) whose bucket PUTs end as `bucket.end` says. `log` holds
 * every request in order: the server's as the fixture saw them, each PUT when the XHR sent it. `fault` answers the
 * server's requests.
 */
function setup({ fault = (() => undefined) as Fault, fetchOption = false, navigator = BROWSER as object } = {}) {
  const log: string[] = [];
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: (call) => {
        if (call.label.startsWith("POST")) log.push(call.label);
        return fault(call);
      },
    },
  );
  const bucket: { end: End; puts: number } = { end: (call) => call.finish(), puts: 0 };
  const xhr = fakeXhr(fixture.fetch, {
    end: (call) => {
      log.push(call.label);
      void bucket.end(call, ++bucket.puts);
    },
  });
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  vi.stubGlobal("fetch", fixture.fetch);
  vi.stubGlobal("navigator", navigator);
  const client = createCloudropClient({
    basePath: fixture.basePath,
    persist: false,
    ...(fetchOption ? { fetch: fixture.fetch } : {}),
  });
  /** Starts `file` with the bucket ending its PUTs by `end`, and waits until the job has settled. */
  const run = async (file: File, end: End) => {
    bucket.end = end;
    const job = client.start("files", file);
    await job.done;
    return job;
  };
  return { fixture, xhr, bucket, log, run };
}

const small = () => new File([offsetBytes(1000)], "a.bin", { type: "application/octet-stream" });
/** Two parts: 8 MiB, then 5 bytes. */
const twoParts = () => new File([offsetBytes(8 * MiB + 5)], "b.bin", { type: "application/octet-stream" });

/** The page's request is refused before its body leaves, as for a preflight the bucket's CORS rule fails. */
const refused = (call: XhrCall) => call.fail();
/** The connection drops after a byte of the body was sent. */
const dropped = (call: XhrCall) => {
  call.progress(1);
  call.fail();
};
/** A failed PUT through a fetch option: a throw, with no progress to report. */
const unreachableBucket: Fault = ({ label }) => {
  if (label.startsWith("PUT")) throw new TypeError("Failed to fetch");
  return undefined;
};

const errorOf = (job: UploadJob<unknown>) => {
  const { status, error } = job.getSnapshot().files[0] ?? {};
  return { status, code: error?.code, retryable: error?.retryable };
};
const BLOCKED = { status: "failed", code: "BUCKET_BLOCKED", retryable: false };
const LOST = { status: "failed", code: "NETWORK_ERROR", retryable: true };
/** One renewal after the first failure, then the rest of the six attempts on the renewed URL. */
const SIX_PUTS = ["POST /upload", "PUT object", "POST /sign", ...Array(5).fill("PUT object")];

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BUCKET_BLOCKED", () => {
  it("fails a single PUT after two refusals without progress around one renewal, before /complete", async () => {
    const { log, run } = setup();
    const job = await run(small(), refused);
    expect({ error: errorOf(job), log }).toEqual({
      error: BLOCKED,
      log: ["POST /upload", "PUT object", "POST /sign", "PUT object"],
    });
  });

  it("says what to check, without a URL", async () => {
    const { run } = setup();
    const job = await run(small(), refused);
    expect(job.getSnapshot().files[0]?.error?.message).toBe(
      "The browser blocked the file's request to the storage service, while the upload server answers. The usual cause is the bucket's CORS rule: it must allow PUT from this page's origin with the headers cloudrop signs (run npx cloudrop doctor --origin <this origin>). A firewall or browser extension that blocks the storage service looks the same.",
    );
  });

  it.each([
    { name: "upload progress before each failure", fault: undefined, end: dropped, log: SIX_PUTS },
    {
      name: "a /sign that answers 503 between the failures",
      fault: ((call) => (call.label === "POST /sign" && call.nth === 1 ? storageBusy() : undefined)) as Fault,
      end: refused,
      // The failed /sign takes one attempt and the renewal it owed comes next, so four PUTs follow it.
      log: ["POST /upload", "PUT object", "POST /sign", "POST /sign", ...Array(4).fill("PUT object")],
    },
    {
      name: "a page that is offline at the second failure",
      fault: undefined,
      end: (call: XhrCall, nth: number) => {
        if (nth === 2) vi.stubGlobal("navigator", { onLine: false });
        call.fail();
      },
      log: SIX_PUTS,
    },
  ])("keeps NETWORK_ERROR after six attempts with $name", async ({ fault, end, log: expected }) => {
    const { log, run } = setup({ fault });
    const job = await run(small(), end);
    expect({ error: errorOf(job), log }).toEqual({ error: LOST, log: expected });
  });

  it("keeps NETWORK_ERROR for an empty file, which never reports a byte sent", async () => {
    const { log, run } = setup();
    // A refused URL (bad signature, expired) sends an empty body too: no progress can tell it from a blocked request.
    const job = await run(new File([], "empty.bin", { type: "application/octet-stream" }), refused);
    expect({ error: errorOf(job), log }).toEqual({ error: LOST, log: SIX_PUTS });
  });

  it("keeps NETWORK_ERROR outside a browser: React Native has XMLHttpRequest and a navigator without onLine", async () => {
    // React Native has no CORS, so a PUT refused before any byte left is a lost connection there (DNS, TLS, handover).
    const { log, run } = setup({ navigator: { product: "ReactNative" } });
    const job = await run(small(), refused);
    expect({ error: errorOf(job), log }).toEqual({ error: LOST, log: SIX_PUTS });
  });

  it("keeps NETWORK_ERROR for PUTs that stall until the 30 s abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { xhr, log, run } = setup();
    // The PUTs stay open: each ends when its stall timer fires. The clock jumps 30 s only while a PUT is open, so no
    // request to the server outlives its own timeout; otherwise it moves 1 ms, the least a timer waits, as in Node.
    let settled = false;
    const job = run(small(), () => undefined).finally(() => {
      settled = true;
    });
    while (!settled) {
      await vi.advanceTimersByTimeAsync(xhr.open.length > 0 ? 30_000 : 1);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect({ error: errorOf(await job), log }).toEqual({ error: LOST, log: SIX_PUTS });
  });

  it("changes nothing for a client with a fetch option", async () => {
    const { fixture, xhr, run } = setup({ fault: unreachableBucket, fetchOption: true });
    const job = await run(small(), refused);
    expect({ error: errorOf(job), requests: fixture.requests, xhr: xhr.sent }).toEqual({
      error: LOST,
      requests: SIX_PUTS,
      xhr: [],
    });
  });

  it("keeps the ticket: retry() sends the PUT again without a new /upload", async () => {
    const { bucket, log, run } = setup();
    const job = await run(small(), refused);
    const before = log.length;
    bucket.end = (call) => call.finish();
    expect({ status: (await job.files[0]?.retry())?.status, sent: log.slice(before) }).toEqual({
      status: "done",
      sent: ["PUT object", "POST /complete"],
    });
  });

  it("fails a multipart file on the part that is refused, and retry() sends only that part", async () => {
    const { bucket, log, run } = setup();
    const job = await run(twoParts(), (call) => (call.label === "PUT part 1" ? call.finish() : call.fail()));
    const failed = { error: errorOf(job), log: [...log].sort() };
    const before = log.length;
    bucket.end = (call) => call.finish();
    expect({ failed, status: (await job.files[0]?.retry())?.status, sent: log.slice(before) }).toEqual({
      failed: {
        error: BLOCKED,
        // Both parts start together, so their order is not part of the contract.
        log: ["POST /sign", "POST /upload", "PUT part 1", "PUT part 2", "PUT part 2"],
      },
      status: "done",
      sent: ["PUT part 2", "POST /complete"],
    });
  });
});
