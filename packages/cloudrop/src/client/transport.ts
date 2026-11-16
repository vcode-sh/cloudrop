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

const putWithXhr: PutObject = (target, body, signal, onBytes) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(unreachable(signal));
    // Read on every PUT, so a page that wraps XMLHttpRequest after the client was created is seen (ruling M3-U6).
    const xhr = new globalThis.XMLHttpRequest();
    const cancel = () => xhr.abort();
    const settle = (outcome: BucketOutcome) => {
      signal.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    xhr.open("PUT", target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => onBytes(event.loaded);
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
    signal.addEventListener("abort", cancel, { once: true });
    // No cookies: XMLHttpRequest sends none cross-origin unless withCredentials is set, and it stays unset.
    xhr.send(body);
  });

/** XMLHttpRequest when there is one and no fetch option was passed; otherwise `send` (ruling M3-U6). */
export function createPut(fetchOption: ClientFetch | undefined, send: ClientFetch): PutObject {
  if (fetchOption === undefined && typeof globalThis.XMLHttpRequest === "function") return putWithXhr;
  return async (target, body, signal, onBytes) => {
    const outcome = await putObject(send, target, body, signal);
    if (outcome.kind === "stored") onBytes(body.size);
    return outcome;
  };
}
