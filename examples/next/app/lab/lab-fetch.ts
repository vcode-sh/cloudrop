// The fetch the lab passes to createCloudropClient: it records each request the client sends and injects the faults
// ticked on the page. Both the upload server's endpoints and the bucket PUTs go through it.
import type { ClientOptions } from "cloudrop/client";
import { displayHost } from "./host";

export type ClientFetch = NonNullable<ClientOptions["fetch"]>;

/** What the log keeps of one request: never its URL, headers or body, which hold a signature or a token. */
export interface RequestRecord {
  /** "/upload", "/sign", "/complete", "/abort", "PUT single" or "PUT part n". */
  kind: string;
  isBucketPut: boolean;
  /** The bucket's host for a PUT, the page's own host for an endpoint call. */
  host: string;
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

/** The URL is read here and nowhere else: only the endpoint's name, the part number and the host leave. */
function readTarget(url: string, method: string): Pick<RequestRecord, "kind" | "isBucketPut" | "host"> {
  const parsed = new URL(url, window.location.href);
  if (method === "PUT") {
    const part = parsed.searchParams.get("partNumber");
    return { kind: part ? `PUT part ${part}` : "PUT single", isBucketPut: true, host: displayHost(parsed.host) };
  }
  return { kind: `/${parsed.pathname.split("/").at(-1)}`, isBucketPut: false, host: parsed.host };
}

function sizeOf(body: RequestInit["body"]): number {
  if (body instanceof Blob) return body.size;
  return typeof body === "string" ? new TextEncoder().encode(body).length : 0;
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

async function sendWithFaults(record: RequestRecord, url: string, init: RequestInit, faults: FaultSwitch) {
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
  const response = await fetch(url, init);
  if (record.kind === "/complete" && faults.take("dropComplete")) {
    // The server has answered, so the file may be complete; the client must not learn it.
    await response.body?.cancel();
    record.injected.push(`answer dropped (the server sent ${response.status})`);
    throw networkError();
  }
  return response;
}

/** A fetch that appends a record per request to `log` and calls `changed` whenever a record starts or ends. */
export function createLabFetch(log: RequestRecord[], faults: FaultSwitch, changed: () => void): ClientFetch {
  return async (url, init) => {
    const record: RequestRecord = {
      ...readTarget(url, init.method ?? "GET"),
      status: null,
      startMs: performance.now(),
      endMs: null,
      bytes: sizeOf(init.body),
      injected: [],
    };
    log.push(record);
    changed();
    try {
      const response = await sendWithFaults(record, url, init, faults);
      record.status = response.status;
      return response;
    } catch (error) {
      record.status = init.signal?.aborted ? "cancelled" : "network error";
      throw error;
    } finally {
      record.endMs = performance.now();
      changed();
    }
  };
}
