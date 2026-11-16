// One presigned PUT to the bucket. In a browser it goes through XMLHttpRequest, the one web API that reports upload
// progress; with a fetch option, or where there is no XMLHttpRequest, through fetch, which reports a part's bytes only
// when it is stored (spec §4.1, ruling M3-U6).

import type { SignedRequest } from "../protocol/types.ts";
import { type BucketOutcome, classifyAnswer, putObject, STORAGE_CODE, unreachable } from "./bucket.ts";
import type { ClientFetch } from "./endpoints.ts";
import { parseRetryAfter } from "./retry.ts";

export type PutObject = (
  target: SignedRequest,
  body: Blob,
  signal: AbortSignal,
  /** The bytes of `body` sent so far by this attempt; with fetch, called once with body.size when it is stored. */
  onBytes: (sent: number) => void,
) => Promise<BucketOutcome>;

// A stall is the network-error outcome (ruling M3-U27, spec §4.6): the PUT is given up, costs one attempt and is sent
// again. An answer that comes more than 30 s after the body was sent, or an XHR the browser queues behind its per-host
// connection limit, counts as a stall too (ruling M3-U47).
/** How long an XHR may go without a progress event; with fetch, the time a PUT gets on top of its bytes. */
const STALL_MS = 30_000;
/** 100 KiB/s: the slowest upload a fetch PUT, which reports no progress, is given time for. */
const SLOWEST_BYTES_PER_MS = 102.4;

const putWithXhr: PutObject = (target, body, signal, onBytes) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(unreachable(signal));
    // Read on every PUT, so a page that wraps XMLHttpRequest after the client was created is seen (ruling M3-U6).
    const xhr = new globalThis.XMLHttpRequest();
    const cancel = () => xhr.abort();
    let stall: ReturnType<typeof setTimeout> | undefined;
    // An abort settles through onabort below: opaque while the caller's signal has not fired.
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(cancel, STALL_MS);
    };
    const settle = (outcome: BucketOutcome) => {
      clearTimeout(stall);
      signal.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    xhr.upload.onprogress = (event) => {
      watch();
      onBytes(event.loaded);
    };
    xhr.onload = () => {
      // 412: a retried create-only PUT whose first attempt already stored the object (spec §5.4).
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 412) {
        onBytes(body.size);
        return settle({ kind: "stored" });
      }
      if (xhr.status === 0) return settle(unreachable(signal));
      const code = STORAGE_CODE.exec(xhr.responseText)?.[1];
      settle(classifyAnswer(xhr.status, code, parseRetryAfter(xhr.getResponseHeader("retry-after"))));
    };
    // A network failure and a refusal without CORS headers look the same here, as with fetch (decision S10).
    const lost = () => settle(unreachable(signal));
    xhr.onerror = lost;
    xhr.ontimeout = lost;
    xhr.onabort = lost;
    try {
      xhr.open("PUT", target.url);
      for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
      // No cookies: XMLHttpRequest sends none cross-origin unless withCredentials is set, and it stays unset.
      watch();
      xhr.send(body);
    } catch {
      // A URL or header the browser refuses throws here, as fetch throws a TypeError for it: the same outcome.
      return settle(unreachable(signal));
    }
    signal.addEventListener("abort", cancel, { once: true });
  });

/** XMLHttpRequest when there is one and no fetch option was passed; otherwise `send` (ruling M3-U6). */
export function createPut(fetchOption: ClientFetch | undefined, send: ClientFetch): PutObject {
  if (fetchOption === undefined && typeof globalThis.XMLHttpRequest === "function") return putWithXhr;
  return async (target, body, signal, onBytes) => {
    // Without AbortSignal.any (ruling M3-U19): one controller that the timeout and the caller's signal both abort.
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timeout = setTimeout(stop, STALL_MS + body.size / SLOWEST_BYTES_PER_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const outcome = await putObject(send, target, body, controller.signal);
      if (outcome.kind === "stored") onBytes(body.size);
      // Aborted by the timeout rather than the caller: opaque, as a stalled XHR is.
      return outcome.kind === "aborted" ? unreachable(signal) : outcome;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
    }
  };
}
