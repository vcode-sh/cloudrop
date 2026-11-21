import { CloudropError, fail, ok, type Result } from "../../errors.ts";
import { MiB } from "../../rules.ts";
import { canonicalQuery, EMPTY_SHA256, sha256Hex, signRequest, UNSIGNED_PAYLOAD } from "../sigv4.ts";
import { storageError } from "../storage-error.ts";
import type { S3Context } from "./context.ts";

type Bytes = Uint8Array<ArrayBuffer>;

interface SendOptions {
  headers?: Record<string, string>;
  body?: Bytes | Blob;
  timeoutMs?: number;
  /** The most bytes a successful answer may carry. The default is none: S3 answers a write or a delete without a body. */
  maxBytes?: number;
}

const decoder = new TextDecoder();
export const REQUEST_TIMEOUT_MS = 30_000;
// A server-side copy of up to 5 GiB runs inside one request, and S3 documents that completing a multipart upload
// "could take several minutes".
export const SLOW_REQUEST_TIMEOUT_MS = 300_000;
/**
 * More than any listing or settings answer cloudrop asks for: 1,000 entries (MAX_LIST_PAGE), each a key of 1,024 bytes
 * with every byte escaped to six characters and under 1 KiB of other fields, come to 7.2 MB.
 */
export const MAX_XML_BYTES: number = 8 * MiB;
// An S3 error is a few hundred bytes and names its code first; a proxy's error page can be any size.
const MAX_ERROR_BYTES = 4096;

/**
 * The body's first `limit` bytes, and whether it has more: the rest is cancelled, never read. The chunks are joined by
 * hand: jsdom 26's `Blob` has no `arrayBuffer()`, and an app's tests run the driver there (M11-R2, M11-R250).
 */
async function readBody(response: Response, limit: number): Promise<{ bytes: Bytes; more: boolean }> {
  const reader = response.body?.getReader();
  const chunks: Bytes[] = [];
  let size = 0;
  while (reader && size <= limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const more = size > limit;
  if (more) reader?.cancel().catch(() => undefined);
  const bytes = new Uint8Array(more ? limit : size);
  let offset = 0;
  for (const chunk of chunks) {
    // Only the last chunk can pass the limit, so the room left is never negative.
    bytes.set(chunk.subarray(0, bytes.length - offset), offset);
    offset += chunk.length;
  }
  return { bytes, more };
}

// A header the platform refused is quoted in its error, and the Authorization header carries the access key ID. The
// quote can sit in a nested cause (an undici error wraps the socket error), which may be a plain object or an error from
// another realm, so every link with a message is searched. A chain deeper than 8 links is dropped unread.
function quotesCredentials(error: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof error === "string") return error.includes("Credential=");
  if (typeof error !== "object" || error === null) return false;
  const { message, cause } = error as { message?: unknown; cause?: unknown };
  return (typeof message === "string" && message.includes("Credential=")) || quotesCredentials(cause, depth + 1);
}

function unreachable(cause: unknown, timeoutMs: number): CloudropError {
  let timedOut = false;
  let safeCause: unknown;
  try {
    timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    if (!quotesCredentials(cause)) safeCause = cause;
  } catch {
    // An uninspectable cause is unsafe to keep, and must not replace a Result with a thrown error.
  }
  return new CloudropError(
    "STORAGE_UNREACHABLE",
    timedOut
      ? `The storage service did not answer within ${timeoutMs / 1000} seconds. Retry the request.`
      : "Could not reach the storage service. Check the endpoint and the network connection, then retry.",
    { retryable: true, cause: safeCause },
  );
}

/**
 * Signs and sends one request and reads its body up to `maxBytes`; every expected failure comes back as a Result. A
 * redirect is never followed: the request is signed for one host, and its headers and body are for that host only.
 */
export async function send(
  ctx: S3Context,
  method: string,
  url: URL,
  options: SendOptions = {},
): Promise<Result<{ headers: Headers; body: Bytes }>> {
  // Called unbound, as the caller's own fetch and clock would be: a browser's fetch refuses any other `this`.
  const { http, now, credentials, region } = ctx;
  // Send exactly the query that is signed: URLSearchParams writes a space as "+", which a server may read literally.
  url.search = canonicalQuery(url.searchParams);
  const { headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = 0 } = options;
  const signedAt = now();
  const signed = await signRequest({
    method,
    url,
    headers,
    credentials,
    region,
    date: signedAt,
    // A Blob is streamed unread, so its hash is unknown; UNSIGNED-PAYLOAD is SigV4's documented value for that.
    payloadHash: body instanceof Blob ? UNSIGNED_PAYLOAD : body ? await sha256Hex(body) : EMPTY_SHA256,
  });
  // R2 gzips a HEAD answer for compressible types from 50 bytes up and then sends no content-length, the stored size a
  // HEAD is read for (r2-spike-findings.md, "HEAD and compression"). Unsigned, so a runtime that rewrites the header
  // cannot break the signature.
  const sent = method === "HEAD" ? { ...signed, "accept-encoding": "identity" } : signed;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await http(url, { method, headers: sent, body, signal, redirect: "manual" });
    // A custom fetch may follow a redirect all the same; its first answer's status is gone, so 302 stands for it.
    const status = response.redirected ? 302 : response.status;
    if (!response.ok || response.redirected) {
      // NaN without a readable Date header, which storageError reads as no offset.
      const clockOffsetMs = Date.parse(response.headers.get("date") ?? "") - signedAt.getTime();
      const { bytes } = await readBody(response, MAX_ERROR_BYTES);
      return fail(storageError(status, decoder.decode(bytes), clockOffsetMs));
    }
    // A server that ignores Range answers 200 with the whole object; never read gigabytes for a 4 KiB sniff.
    if (headers.range !== undefined && response.status !== 206) {
      await response.body?.cancel();
      return fail(
        new CloudropError(
          "STORAGE_ERROR",
          "The storage service ignored the byte range. Check that the endpoint supports ranged GET.",
          { status: response.status },
        ),
      );
    }
    const { bytes, more } = await readBody(response, maxBytes);
    if (more) {
      // A page from a console port, an app's host or a captive portal, or a server that sends past the range asked for.
      return fail(
        new CloudropError(
          "STORAGE_ERROR",
          "The storage endpoint sent more data than an S3 answer holds. Check the endpoint setting.",
          { status },
        ),
      );
    }
    return ok({ headers: response.headers, body: bytes });
  } catch (cause) {
    // Also covers a connection dropped or timed out while a body was read, and a Blob that could not be read.
    return fail(unreachable(cause, timeoutMs));
  }
}

export async function sendForXml(
  ctx: S3Context,
  method: string,
  url: URL,
  options?: SendOptions,
): Promise<Result<string>> {
  const result = await send(ctx, method, url, { ...options, maxBytes: MAX_XML_BYTES });
  if (result.error) return result;
  const text = decoder.decode(result.data.body);
  // CompleteMultipartUpload and CopyObject can answer HTTP 200 with an <Error> body. S3 documents it as a
  // server-side failure, so classify it like a 500.
  if (text.includes("<Error>")) return fail(storageError(500, text));
  return ok(text);
}
