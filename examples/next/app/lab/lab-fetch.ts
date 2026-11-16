// The run's request log, and the fetch that records the client's requests and injects the faults ticked on the page.
// By default the lab installs it as window.fetch for the upload server's endpoints only (bucket PUTs go through
// lab-xhr.ts); with "Send PUTs with fetch" it is the client's fetch option and sees the bucket PUTs too.
import type { ClientOptions } from "cloudrop/client";
import { displayHost } from "./host";

type ClientFetch = NonNullable<ClientOptions["fetch"]>;

/** What the log keeps of one request: never its URL, headers or body, which hold a signature or a token. */
export interface RequestRecord {
  /** "/upload", "/sign", "/complete", "/abort", "PUT single" or "PUT part n". */
  kind: string;
  isBucketPut: boolean;
  /** The bucket's host for a PUT, the page's own host for an endpoint call. */
  host: string;
  /** The upload the request belongs to, as a number the run gives it: one file's requests apart from another's. */
  subject: string;
  /** For a /sign, the URL it asks for: "the PUT" or "part n"; null for every other request. */
  signedFor: string | null;
  /** An HTTP status; null while the request is in flight. */
  status: number | "network error" | "cancelled" | null;
  startMs: number;
  endMs: number | null;
  /** The size of the request body. */
  bytes: number;
  /** The faults the lab injected into this request, in words. */
  injected: string[];
}

export type OneShotFault = "bucketNetworkError" | "endpoint503" | "dropComplete";

export interface FaultSwitch {
  /** Every bucket PUT waits this long before it is sent; 0 for none. */
  delayMs(): number;
  /** True once if `fault` is ticked, which unticks it. */
  take(fault: OneShotFault): boolean;
}

export interface Journal {
  /** Appends a record for a request about to be sent. The URL and body are read here and kept nowhere. */
  start(url: string, method: string, body: unknown): RequestRecord;
  end(record: RequestRecord, status: NonNullable<RequestRecord["status"]>): void;
}

function sizeOf(body: unknown): number {
  if (body instanceof Blob) return body.size;
  return typeof body === "string" ? new TextEncoder().encode(body).length : 0;
}

type Target = Pick<RequestRecord, "kind" | "isBucketPut" | "host" | "signedFor"> & {
  /** What tells this request's upload from another's: a PUT's URL path or an endpoint's token. Held only as a key in
   * memory for the run's numbering; never shown, logged or stored. */
  secret: string;
};

/** The URL and body are read here and nowhere else: only the endpoint's name, the part number and the host leave. */
function readTarget(url: string, method: string, body: unknown): Target {
  const parsed = new URL(url, window.location.href);
  if (method === "PUT") {
    const part = parsed.searchParams.get("partNumber");
    const kind = part ? `PUT part ${part}` : "PUT single";
    return { kind, isBucketPut: true, host: displayHost(parsed.host), signedFor: null, secret: parsed.pathname };
  }
  // /sign, /complete and /abort send { token }; a /sign adds the parts it asks for, and /upload has no token.
  const { token = "", parts } = (typeof body === "string" ? JSON.parse(body) : {}) as {
    token?: string;
    parts?: number[];
  };
  const kind = `/${parsed.pathname.split("/").at(-1)}`;
  const signedFor = kind === "/sign" ? (parts ? `part ${parts.join(", ")}` : "the PUT") : null;
  return { kind, isBucketPut: false, host: parsed.host, signedFor, secret: token };
}

/** A log that calls `changed` whenever a record starts or ends. */
export function createJournal(log: RequestRecord[], changed: () => void): Journal {
  // Each upload gets a number on first sight, so the notes tell one file's requests from another's; the numbers die
  // with the run.
  const numbers = new Map<string, string>();
  function numberOf(secret: string): string {
    const known = numbers.get(secret);
    if (known) return known;
    const next = String(numbers.size + 1);
    numbers.set(secret, next);
    return next;
  }
  return {
    start(url, method, body) {
      const { secret, ...target } = readTarget(url, method, body);
      const record: RequestRecord = {
        ...target,
        subject: numberOf(secret),
        status: null,
        startMs: performance.now(),
        endMs: null,
        bytes: sizeOf(body),
        injected: [],
      };
      log.push(record);
      changed();
      return record;
    },
    end(record, status) {
      record.status = status;
      record.endMs = performance.now();
      changed();
    },
  };
}

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
  if (record.isBucketPut && faults.take("bucketNetworkError")) {
    record.injected.push("injected network error");
    throw networkError();
  }
  if ((record.kind === "/upload" || record.kind === "/sign") && faults.take("endpoint503")) {
    record.injected.push("injected 503");
    // What a proxy in front of the app sends: a page, not cloudrop's error body.
    return new Response("<h1>Service Unavailable</h1>", { status: 503, headers: { "content-type": "text/html" } });
  }
  const response = await send(url, init);
  if (record.kind === "/complete" && faults.take("dropComplete")) {
    // The server has answered, so the file may be complete; the client must not learn it.
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
      const response = await sendWithFaults(record, url, init, faults, send);
      journal.end(record, response.status);
      return response;
    } catch (error) {
      journal.end(record, init.signal?.aborted ? "cancelled" : "network error");
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
