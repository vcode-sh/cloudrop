// Signature checks of the fake R2. They re-sign each request with cloudrop's own signer, so they prove R2's rules
// (signed headers, expiry, clock skew), never the signer itself.

import { R2_RULES } from "../../rules.ts";
import { presignUrl, sha256Hex, signRequest, UNSIGNED_PAYLOAD } from "../../storage/sigv4.ts";
import { type Bytes, type FakeBucket, META_PREFIX } from "./bucket.ts";
import { clockSkewed, errorResponse } from "./responses.ts";

// S3 rejects a request dated further ahead than this; the spike measured 30 minutes ahead (Q7).
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
// Headers the signer adds itself, so they are not read back from the request.
const PRESIGNED_SKIPPED = ["host"];
const HEADER_SIGNED_SKIPPED = ["host", "x-amz-date", "x-amz-content-sha256"];

const signatureMismatch = (): Response =>
  errorResponse(403, "SignatureDoesNotMatch", "The request signature does not match.");

function parseAmzDate(value: string): Date {
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
}

// The signer canonicalises from URLSearchParams, which reads "+" as a space. S3 reads the query as written, where "+"
// is a literal plus, so a request whose query differs from the signed one only in encoding must fail the signature.
// Rebuilding the pairs with decodeURIComponent alone makes the signer see the query the way S3 does.
function queryAsWritten(url: URL): URL {
  const params = new URLSearchParams();
  for (const pair of url.search.slice(1).split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    params.append(
      decodeURIComponent(at < 0 ? pair : pair.slice(0, at)),
      at < 0 ? "" : decodeURIComponent(pair.slice(at + 1)),
    );
  }
  const rebuilt = new URL(url);
  rebuilt.search = params.toString();
  return rebuilt;
}

// A signed content-length is the body's real length: fetch derives the header from the body, so the fake does too.
function signedHeaderValue(request: Request, name: string, body: Bytes): string | null {
  return name === "content-length" ? String(body.length) : request.headers.get(name);
}

function collectSignedHeaders(
  request: Request,
  names: string[],
  body: Bytes,
  skipped: string[],
): Record<string, string> | Response {
  const headers: Record<string, string> = {};
  for (const name of names) {
    if (skipped.includes(name)) continue;
    const value = signedHeaderValue(request, name, body);
    if (value === null) return errorResponse(403, "SignatureDoesNotMatch", `Signed header ${name} is missing.`);
    headers[name] = value;
  }
  return headers;
}

function presignedWindow(query: URLSearchParams, now: () => Date): { signedAt: Date; expires: number } | Response {
  const signedAt = parseAmzDate(query.get("X-Amz-Date") ?? "");
  const expires = Number(query.get("X-Amz-Expires"));
  if (Number.isNaN(signedAt.getTime())) {
    return errorResponse(400, "AuthorizationQueryParametersError", "X-Amz-Date is missing or malformed.");
  }
  if (!Number.isInteger(expires) || expires < 1 || expires > R2_RULES.maxPresignSeconds) {
    return errorResponse(400, "InvalidArgument", "X-Amz-Expires must be between 1 and 604800 seconds.");
  }
  if (signedAt.getTime() - now().getTime() > MAX_CLOCK_SKEW_MS) return clockSkewed();
  if (now().getTime() > signedAt.getTime() + expires * 1000) {
    return errorResponse(403, "ExpiredRequest", "Request has expired.");
  }
  return { signedAt, expires };
}

// Measured on real R2 for a presigned PUT only (live lane, 2026-11-15, spike row 18): an x-amz-meta-* header the
// URL did not sign fails the signature. Other methods were not measured, so the fake does not assert it for them.
function unsignedMetadata(request: Request, signedNames: string[]): Response | null {
  if (request.method !== "PUT") return null;
  const name = [...request.headers.keys()].find(
    (header) => header.startsWith(META_PREFIX) && !signedNames.includes(header),
  );
  return name ? errorResponse(403, "SignatureDoesNotMatch", `Header ${name} is not signed.`) : null;
}

function withoutSignature(url: URL): URL {
  const unsigned = new URL(url);
  for (const name of Array.from(unsigned.searchParams.keys())) {
    if (name.startsWith("X-Amz-")) unsigned.searchParams.delete(name);
  }
  return unsigned;
}

async function verifyPresigned(bucket: FakeBucket, request: Request, url: URL, body: Bytes): Promise<Response | null> {
  const query = url.searchParams;
  const window = presignedWindow(query, bucket.now);
  if (window instanceof Response) return window;
  const signedNames = (query.get("X-Amz-SignedHeaders") ?? "").split(";");
  const headers = collectSignedHeaders(request, signedNames, body, PRESIGNED_SKIPPED);
  if (headers instanceof Response) return headers;
  const unsigned = unsignedMetadata(request, signedNames);
  if (unsigned) return unsigned;
  const expected = await presignUrl({
    method: request.method,
    url: withoutSignature(url),
    headers,
    credentials: bucket.credentials,
    region: (query.get("X-Amz-Credential") ?? "").split("/")[2] ?? "",
    date: window.signedAt,
    expiresIn: window.expires,
  });
  return expected.searchParams.get("X-Amz-Signature") === query.get("X-Amz-Signature") ? null : signatureMismatch();
}

async function verifyHeaderSigned(
  bucket: FakeBucket,
  request: Request,
  url: URL,
  body: Bytes,
): Promise<Response | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return errorResponse(403, "AccessDenied", "The request is not signed.");
  // R2 answers an access key ID it does not know with 401, and cannot check anything else without the key's secret:
  // bare to HEAD, "Unauthorized" otherwise (r2-spike-findings.md, "An unknown access key"; M9-H5). Measured for
  // header-signed requests only, so a presigned URL of an unknown key still fails its signature.
  if (/Credential=([^/]*)/.exec(authorization)?.[1] !== bucket.credentials.accessKeyId) {
    return errorResponse(401, "Unauthorized", "Unauthorized");
  }
  const signedAt = parseAmzDate(request.headers.get("x-amz-date") ?? "");
  if (Number.isNaN(signedAt.getTime())) {
    return errorResponse(403, "SignatureDoesNotMatch", "X-Amz-Date is missing or malformed.");
  }
  // A header-signed request has no expiry, so both a stale and a future date are skew.
  if (Math.abs(signedAt.getTime() - bucket.now().getTime()) > MAX_CLOCK_SKEW_MS) return clockSkewed();
  const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
  if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== (await sha256Hex(body))) {
    return errorResponse(400, "XAmzContentSHA256Mismatch", "The payload hash does not match the body.");
  }
  const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
  const headers = collectSignedHeaders(request, signedNames, body, HEADER_SIGNED_SKIPPED);
  if (headers instanceof Response) return headers;
  const expected = await signRequest({
    method: request.method,
    url,
    headers,
    credentials: bucket.credentials,
    region: /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(authorization)?.[1] ?? "",
    date: signedAt,
    payloadHash,
  });
  return expected.authorization === authorization ? null : signatureMismatch();
}

/** Checks a presigned or header-signed request the way R2 does; `null` means it may proceed. */
export async function verifySignature(
  bucket: FakeBucket,
  request: Request,
  url: URL,
  body: Bytes,
): Promise<Response | null> {
  let writtenUrl: URL;
  try {
    writtenUrl = queryAsWritten(url);
  } catch {
    return errorResponse(400, "InvalidURI", "The query string is not valid percent-encoding.");
  }
  return url.searchParams.has("X-Amz-Signature")
    ? verifyPresigned(bucket, request, writtenUrl, body)
    : verifyHeaderSigned(bucket, request, writtenUrl, body);
}
