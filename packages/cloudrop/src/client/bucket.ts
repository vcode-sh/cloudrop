// What the bucket answered to a presigned PUT, and what the client does about it (decision S10).

import type { CloudropError } from "../errors.ts";
import type { SignedRequest } from "../protocol/types.ts";
import type { ClientFetch } from "./endpoints.ts";
import {
  aborted,
  bucketUnreachable,
  linkRefused,
  signatureMismatch,
  storageBusy,
  storageDown,
  uploadGone,
  uploadRejected,
} from "./failures.ts";
import { parseRetryAfter } from "./retry.ts";

/**
 * stored: the object or part is in the bucket. opaque: no answer could be read; renew the URL once, wait, retry.
 * expired: renew the URL once and retry at once. retry: wait at least `retryAfterMs`, then retry. rejected and
 * aborted: stop. `error` is what the caller returns once it stops trying.
 */
export type BucketOutcome =
  | { kind: "stored" }
  | { kind: "opaque" | "expired" | "retry"; error: CloudropError; retryAfterMs: number }
  | { kind: "rejected" | "aborted"; error: CloudropError };

/** The S3 error code in a storage answer's XML body. */
const STORAGE_CODE = /<Code>([A-Za-z]{1,64})<\/Code>/;

/**
 * A storage answer that is not a success, from its status, body and Retry-After header, as the server's driver
 * classifies: by status; the body's S3 code only tells a bad signature from an expired URL, and a gone upload from
 * another 404.
 */
export function classifyAnswer(status: number, body: string, retryAfter: string | null): BucketOutcome {
  const storageCode = STORAGE_CODE.exec(body)?.[1];
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (status === 403) {
    // R2 and Wrangler say ExpiredRequest, RustFS says AccessDenied: every other 403 is worth one renewal.
    return storageCode === "SignatureDoesNotMatch"
      ? { kind: "rejected", error: signatureMismatch() }
      : { kind: "expired", error: linkRefused(), retryAfterMs };
  }
  // R2 throttles with 429 and the S3 code ServiceUnavailable (spike Q9), so the status decides.
  if (status === 429 || status === 503) return { kind: "retry", error: storageBusy(), retryAfterMs };
  // 501 Not Implemented: the storage service lacks the feature, so a retry can never succeed.
  if (status === 408 || (status >= 500 && status !== 501)) return { kind: "retry", error: storageDown(), retryAfterMs };
  // A part of an upload that was aborted (another tab, the sweep, the bucket's lifecycle rule): no new URL revives it.
  if (status === 404 && storageCode === "NoSuchUpload") return { kind: "rejected", error: uploadGone() };
  return { kind: "rejected", error: uploadRejected(status) };
}

/** A PUT that got no readable answer: cancelled by the caller, or lost to the network or a refusal without CORS. */
export function unreachable(signal: AbortSignal): BucketOutcome {
  return signal.aborted
    ? { kind: "aborted", error: aborted() }
    : { kind: "opaque", error: bucketUnreachable(), retryAfterMs: 0 };
}

/** Sends one presigned PUT with exactly the signed headers. Never rejects. */
export async function putObject(
  fetch: ClientFetch,
  target: SignedRequest,
  body: Blob,
  signal: AbortSignal,
): Promise<BucketOutcome> {
  let response: Response;
  try {
    // No cookies: the URL is the credential, and a credentialed request needs CORS rules the bucket does not send.
    response = await fetch(target.url, { method: "PUT", headers: target.headers, body, credentials: "omit", signal });
  } catch {
    // Not only the network: R2 sends a refused URL (expired, bad signature) without CORS headers, which a browser shows
    // as a throw (r2-spike-findings.md, "Browser refusals and checksums, 2026-11-16").
    return unreachable(signal);
  }
  // 412: a retried create-only PUT whose first attempt already stored the object (spec §5.4).
  if (response.ok || response.status === 412) {
    // Frees the connection; a body that already failed changes nothing.
    await response.body?.cancel().catch(() => undefined);
    return { kind: "stored" };
  }
  const text = await response.text().catch(() => "");
  return classifyAnswer(response.status, text, response.headers.get("retry-after"));
}
