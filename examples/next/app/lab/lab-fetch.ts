// The fetch that records the client's requests and injects the faults ticked on the page.
// By default the lab installs it as window.fetch for the upload server's endpoints only (bucket PUTs go through
// lab-xhr.ts); with "Send PUTs with fetch" it is the client's fetch option and sees the bucket PUTs too.
import type { ClientOptions } from "cloudrop/client";
import type { Journal, RequestRecord } from "./journal";

type ClientFetch = NonNullable<ClientOptions["fetch"]>;

export type OneShotFault = "bucketNetworkError" | "dropBucketAnswer" | "endpoint503" | "dropComplete";
/** Faults that hit every matching request while ticked. */
export type HeldFault = "part2NetworkError" | "bucket400" | "holdComplete";

export interface FaultSwitch {
  /** Every bucket PUT waits this long before it is sent; 0 for none. */
  delayMs(): number;
  /** True once if `fault` is ticked, which unticks it. */
  take(fault: OneShotFault): boolean;
  /** True while `fault` is ticked. */
  on(fault: HeldFault): boolean;
  /** True from a person's Pause or Cancel until the next Resume or run, and while the page is offline. */
  stopAsked(): boolean;
}

/**
 * What a request the client aborted is called. The client aborts for a pause, a cancel or going offline, and on its own
 * for a stall; it does not say which, so the lab tells them apart by whether anyone asked it to stop.
 */
export const abortedAs = (faults: FaultSwitch): "cancelled" | "stalled" =>
  faults.stopAsked() ? "cancelled" : "stalled";

/** What a bucket sends for a request it will never accept: an S3 error body, readable through its CORS rule. */
export const REFUSAL = { status: 400, body: "<Error><Code>InvalidArgument</Code></Error>" } as const;

/**
 * The bucket fault ticked for this PUT: a network error, the bucket's answer dropped once it is sent, the lab's 400 in
 * the bucket's place, or none. Noted in its record, apart from a dropped answer, which the sender notes with the
 * bucket's status. A held fault that applies leaves the one-shot faults ticked for the next PUT.
 */
export function bucketFault(
  record: RequestRecord,
  faults: FaultSwitch,
): "network error" | "answer dropped" | "refused" | null {
  const partTwo = record.kind === "PUT part 2" && faults.on("part2NetworkError");
  if (partTwo || faults.take("bucketNetworkError")) {
    record.injected.push("injected network error");
    return "network error";
  }
  if (faults.take("dropBucketAnswer")) return "answer dropped";
  if (!faults.on("bucket400")) return null;
  record.injected.push("injected 400");
  record.bytes = 0;
  return "refused";
}

/** How often a held /complete looks at its box: the lab hears of an untick only by asking. */
const HOLD_CHECK_MS = 100;

/** A browser's own words for a request that got no readable answer. */
const networkError = () => new TypeError("Failed to fetch");

/** Waits `ms`, or rejects as fetch does when the signal fires first. */
function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }, ms);
    if (signal?.aborted) cancelled();
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

async function sendWithFaults(
  record: RequestRecord,
  url: string,
  init: RequestInit,
  faults: FaultSwitch,
  send: ClientFetch,
) {
  const delayMs = faults.delayMs();
  if (record.isBucketPut && delayMs > 0) {
    record.injected.push(`delayed ${delayMs} ms`);
    await delay(delayMs, init.signal);
  }
  const fault = record.isBucketPut ? bucketFault(record, faults) : null;
  if (fault === "network error") throw networkError();
  if (fault === "answer dropped") {
    const response = await send(url, init);
    await response.body?.cancel();
    record.injected.push(`answer dropped (the bucket sent ${response.status})`);
    throw networkError();
  }
  if (fault === "refused") {
    return new Response(REFUSAL.body, { status: REFUSAL.status, headers: { "content-type": "application/xml" } });
  }
  if ((record.kind === "/upload" || record.kind === "/sign") && faults.take("endpoint503")) {
    record.injected.push("injected 503");
    // What a proxy in front of the app sends: a page, not cloudrop's error body.
    return new Response("<h1>Service Unavailable</h1>", { status: 503, headers: { "content-type": "text/html" } });
  }
  return send(url, init);
}

/** The server's answer to a /complete, held while that box is ticked, or dropped once. */
async function completeAnswer(
  journal: Journal,
  record: RequestRecord,
  response: Response,
  faults: FaultSwitch,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  // The server has answered, so the file may be complete; the client must not learn it yet, or at all.
  if (faults.on("holdComplete")) {
    // Shown now, while the request stays in flight. A reload ends the wait with the page, and the answer is never heard.
    journal.note(record, `answer held (the server sent ${response.status})`);
    try {
      while (faults.on("holdComplete")) await delay(HOLD_CHECK_MS, signal);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
  }
  if (faults.take("dropComplete")) {
    await response.body?.cancel();
    record.injected.push(`answer dropped (the server sent ${response.status})`);
    throw networkError();
  }
  return response;
}

/** A fetch that records each request in `journal` and sends it through `send`, the browser's own fetch. */
export function createLabFetch(journal: Journal, faults: FaultSwitch, send: ClientFetch): ClientFetch {
  return async (url, init) => {
    const record = journal.start(url, init.method ?? "GET", init.body);
    try {
      const sent = await sendWithFaults(record, url, init, faults, send);
      const response =
        record.kind === "/complete" ? await completeAnswer(journal, record, sent, faults, init.signal) : sent;
      journal.end(record, response.status);
      return response;
    } catch (error) {
      journal.end(record, init.signal?.aborted ? abortedAs(faults) : "network error");
      throw error;
    }
  };
}

/**
 * Makes window.fetch record the calls to the upload server, until the returned function puts the browser's back.
 * Anything else the page fetches passes through unrecorded.
 */
export function installLabFetch(journal: Journal, faults: FaultSwitch): () => void {
  const original = window.fetch;
  // Bound before installing: the lab's fetch sends through it, and through window.fetch it would call itself.
  const realFetch = window.fetch.bind(window);
  const labFetch = createLabFetch(journal, faults, realFetch);
  const isEndpoint = (url: URL) => url.origin === window.location.origin && url.pathname.startsWith("/api/cloudrop/");
  window.fetch = (input, init) =>
    typeof input === "string" && isEndpoint(new URL(input, window.location.href))
      ? labFetch(input, init ?? {})
      : realFetch(input, init);
  return () => {
    window.fetch = original;
  };
}
