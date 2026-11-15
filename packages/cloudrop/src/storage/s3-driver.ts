import { CloudropError, configError, fail, ok, type Result } from "../errors.ts";
import { MiB, type StorageRules } from "../rules.ts";
import type {
  BucketLifecycleRule,
  CompletedPart,
  FetchLike,
  ObjectInfo,
  ObjectOptions,
  PartInfo,
  PresignedRequest,
  StorageDriver,
  WriteOptions,
} from "./driver.ts";
import {
  type Credentials,
  canonicalQuery,
  EMPTY_SHA256,
  encodeKeyPath,
  encodeRfc3986,
  presignUrl,
  sha256Hex,
  signRequest,
  UNSIGNED_PAYLOAD,
} from "./sigv4.ts";
import { storageError } from "./storage-error.ts";
import {
  bodyProblem,
  checksumProblem,
  cursorProblem,
  expiryProblem,
  invalidInput,
  keyListProblem,
  keyProblem,
  limitProblem,
  MAX_LIST_PAGE,
  objectOptionsProblem,
  partNumberProblem,
  partsProblem,
  prefixProblem,
  rangeProblem,
  sizeProblem,
  uploadIdProblem,
} from "./validate.ts";
import { escapeXml, stripQuotes, xmlBlocks, xmlText, xmlTexts } from "./xml.ts";

export interface S3DriverConfig {
  /**
   * An http or https URL with no query or fragment, such as "https://<account>.r2.cloudflarestorage.com". A path is
   * kept as a prefix of every request.
   */
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials;
  rules: StorageRules;
  publicUrl?: string;
  fetch?: FetchLike;
  /** Clock for signing; tests use it to produce expired URLs. */
  now?: () => Date;
}

type Bytes = Uint8Array<ArrayBuffer>;

interface SendOptions {
  headers?: Record<string, string>;
  body?: Bytes | Blob;
  timeoutMs?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const META_PREFIX = "x-amz-meta-";
const DELETE_CONCURRENCY = 16;
const REQUEST_TIMEOUT_MS = 30_000;
// A server-side copy of up to 5 GiB runs inside one request, and S3 documents that completing a multipart upload
// "could take several minutes".
const SLOW_REQUEST_TIMEOUT_MS = 300_000;

function objectHeaders(options: ObjectOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.type) headers["content-type"] = options.type;
  if (options.disposition) headers["content-disposition"] = options.disposition;
  for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`${META_PREFIX}${name}`] = value;
  return headers;
}

function writeHeaders(options: WriteOptions): Record<string, string> {
  const headers = objectHeaders(options);
  if (options.ifNoneMatch) headers["if-none-match"] = "*";
  if (options.checksumCrc32c) headers["x-amz-checksum-crc32c"] = options.checksumCrc32c;
  return headers;
}

// Plain-JavaScript callers can pass null or nothing. An empty object lets the field checks answer with a clear
// INVALID_INPUT (for example a missing size) instead of a TypeError; for optional options it is the right default.
function orEmpty<T extends object>(options: T | null | undefined): T {
  return options ?? ({} as T);
}

const etagIn = (xml: string): string => stripQuotes(xmlText(xml, "ETag") ?? "");

/** A 2xx response without a field cloudrop needs: a fault on the storage side, worth a retry. */
function incompleteResponse(missing: string): CloudropError {
  return new CloudropError("STORAGE_ERROR", `The storage service's response had no ${missing}. Retry the request.`, {
    retryable: true,
  });
}

/** Every copy request names the ETag HEAD read, so a 412 means the source was overwritten after that. */
function copyError(error: CloudropError): CloudropError {
  if (error.status !== 412) return error;
  return new CloudropError("STORAGE_ERROR", "The object to copy changed during the copy. Retry the copy.", {
    status: 412,
    storageCode: error.storageCode,
    retryable: true,
  });
}

function readObjectInfo(key: string, headers: Headers): ObjectInfo {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(META_PREFIX)) metadata[name.slice(META_PREFIX.length)] = value;
  });
  return {
    key,
    size: Number(headers.get("content-length")),
    type: headers.get("content-type") ?? undefined,
    disposition: headers.get("content-disposition") ?? undefined,
    etag: stripQuotes(headers.get("etag") ?? ""),
    uploadedAt: new Date(headers.get("last-modified") ?? 0),
    metadata,
    checksumCrc64nvme: headers.get("x-amz-checksum-crc64nvme") ?? undefined,
  };
}

/**
 * The endpoint and the publicUrl: keys are appended to the path, so a query or fragment would swallow them (and be
 * signed into every request). A path is a prefix: a CDN folder, or Wrangler's /cdn-cgi/local/r2/s3.
 */
function checkBaseUrl(value: string, setting: string, example: string): URL {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : null;
  if (url?.username || url?.password) {
    throw configError(
      `The ${setting} contains a user name or password. Remove it; cloudrop takes credentials only as accessKeyId and secretAccessKey.`,
    );
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.href !== `${url.origin}${url.pathname}`) {
    throw configError(`The ${setting} must be an http or https URL with no query or fragment, such as ${example}.`);
  }
  // Check the path the way the signer reads it: the URL parser keeps a bad escape as written, and signing it would
  // later throw URIError from a public call.
  try {
    for (const segment of url.pathname.split("/")) decodeURIComponent(segment);
  } catch {
    throw configError(
      `The ${setting}'s path contains a malformed percent escape, or one that is not valid UTF-8 (such as %zz or %FF). Write a literal percent sign as %25.`,
    );
  }
  return url;
}

// Checked once, at construction: a header value with a line break makes fetch throw, and Node quotes the whole
// Authorization header (access key ID and signature) in that error.
const SIGNABLE = /^[\x21-\x7e]+$/;

function checkSigningSettings({ credentials, region }: S3DriverConfig): void {
  for (const [setting, value] of Object.entries(credentials)) {
    if (typeof value !== "string" || !SIGNABLE.test(value)) {
      throw configError(
        `The ${setting} setting must be printable ASCII text with no whitespace or line break; secret files often end in a newline. Copy the value again without it.`,
      );
    }
  }
  // The region is one segment of the signing scope "<date>/<region>/s3/aws4_request".
  if (typeof region !== "string" || !SIGNABLE.test(region) || region.includes("/")) {
    throw configError(
      "The region setting must be printable ASCII text with no whitespace, line break or slash, such as us-east-1 or auto.",
    );
  }
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

/**
 * A failed bucket-configuration read. Only S3's documented "no such configuration" code means no rules: a proxy or a
 * wrong endpoint path also answers 404, and reading that as no rules would report a rule nobody read. R2's own code
 * for a bucket without the setting is unmeasured (the test token gets 403), so this follows S3.
 */
function configurationReadError(error: CloudropError, missingCode: string, setting: string): Result<never[]> {
  if (error.status === 404 && error.storageCode === missingCode) return ok([]);
  if (error.code !== "NOT_FOUND") return fail(error);
  return fail(
    new CloudropError(
      "STORAGE_ERROR",
      `The storage service answered 404 without saying that the bucket has no ${setting} configuration. Check the endpoint, then retry.`,
      { status: 404, storageCode: error.storageCode, retryable: true },
    ),
  );
}

// X-Amz-Date takes toISOString's year, which has four digits only up to 9999. Times before 1970 are refused too: no
// presigned URL needs one, and they usually mean a seconds value was passed where milliseconds belong.
const SIGNABLE_UNTIL_MS = Date.UTC(10000, 0, 1);

function unreachable(cause: unknown, timeoutMs: number): CloudropError {
  const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
  return new CloudropError(
    "STORAGE_UNREACHABLE",
    timedOut
      ? `The storage service did not answer within ${timeoutMs / 1000} seconds. Retry the request.`
      : "Could not reach the storage service. Check the endpoint and the network connection, then retry.",
    { retryable: true, cause: quotesCredentials(cause) ? undefined : cause },
  );
}

async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function createS3Driver(config: S3DriverConfig): StorageDriver {
  const http: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  if (typeof http !== "function") {
    throw configError(
      "The fetch option must be a function, such as globalThis.fetch. Omit it to use the global fetch.",
    );
  }
  checkSigningSettings(config);
  const now = config.now ?? (() => new Date());
  // One credentials object for the driver's lifetime: sigv4 caches signing keys per object.
  const { credentials, region, rules } = config;
  const endpoint = checkBaseUrl(config.endpoint, "storage endpoint", "https://<account ID>.r2.cloudflarestorage.com");
  const bucketUrl = `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}/${encodeRfc3986(config.bucket)}`;
  const publicUrl =
    config.publicUrl === undefined
      ? undefined
      : // Trailing slashes dropped so callers can append "/<key>".
        checkBaseUrl(config.publicUrl, "publicUrl", "https://cdn.example.com/files").href.replace(/\/+$/, "");

  function objectUrl(key: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${bucketUrl}/${encodeKeyPath(key)}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  /** Signs and sends one request and reads its whole body; every expected failure comes back as a Result. */
  async function send(
    method: string,
    url: URL,
    options: SendOptions = {},
  ): Promise<Result<{ headers: Headers; body: Bytes }>> {
    // Send exactly the query that is signed: URLSearchParams writes a space as "+", which a server may read literally.
    url.search = canonicalQuery(url.searchParams);
    const { headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = options;
    const signed = await signRequest({
      method,
      url,
      headers,
      credentials,
      region,
      date: now(),
      // A Blob is streamed unread, so its hash is unknown; UNSIGNED-PAYLOAD is SigV4's documented value for that.
      payloadHash: body instanceof Blob ? UNSIGNED_PAYLOAD : body ? await sha256Hex(body) : EMPTY_SHA256,
    });
    try {
      const response = await http(url, { method, headers: signed, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return fail(storageError(response.status, await response.text()));
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
      return ok({ headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) });
    } catch (cause) {
      // Also covers a connection dropped or timed out while a body was read, and a Blob that could not be read.
      return fail(unreachable(cause, timeoutMs));
    }
  }

  async function sendForXml(method: string, url: URL, options?: SendOptions): Promise<Result<string>> {
    const result = await send(method, url, options);
    if (result.error) return result;
    const text = decoder.decode(result.data.body);
    // CompleteMultipartUpload and CopyObject can answer HTTP 200 with an <Error> body. S3 documents it as a
    // server-side failure, so classify it like a 500.
    if (text.includes("<Error>")) return fail(storageError(500, text));
    return ok(text);
  }

  async function presign(
    url: URL,
    headers: Record<string, string>,
    size: number,
    expiresIn: number,
  ): Promise<PresignedRequest> {
    const date = now();
    const signed = await presignUrl({
      method: "PUT",
      url,
      headers: { ...headers, "content-length": String(size) },
      credentials,
      region,
      date,
      expiresIn,
    });
    return { method: "PUT", url: signed.toString(), headers, expiresAt: new Date(date.getTime() + expiresIn * 1000) };
  }

  /** Not validated: createMultipart checks caller input first; a copy passes headers the storage itself returned. */
  async function startMultipart(key: string, options: ObjectOptions): Promise<Result<{ uploadId: string }>> {
    const result = await sendForXml("POST", objectUrl(key, { uploads: "" }), { headers: objectHeaders(options) });
    if (result.error) return result;
    const uploadId = xmlText(result.data, "UploadId");
    return uploadId ? ok({ uploadId }) : fail(incompleteResponse("upload ID"));
  }

  async function copyInParts(
    source: ObjectInfo,
    copyHeaders: Record<string, string>,
    to: string,
  ): Promise<Result<{ etag: string }>> {
    // The largest part one request may carry: a server-side copy streams nothing through us, so fewer requests win.
    // Equal parts with a smaller last one also satisfy R2's equal-part rule by construction.
    const partSize = rules.maxSinglePutSize;
    const partCount = Math.ceil(source.size / partSize);
    const created = await startMultipart(to, source);
    if (created.error) return created;
    const { uploadId } = created.data;
    const abortWith = async (error: CloudropError): Promise<Result<never>> => {
      await driver.abortMultipart(to, uploadId);
      return fail(error);
    };
    const parts: CompletedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, source.size) - 1;
      const result = await sendForXml("PUT", objectUrl(to, { partNumber: String(partNumber), uploadId }), {
        headers: { ...copyHeaders, "x-amz-copy-source-range": `bytes=${start}-${end}` },
        timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
      });
      if (result.error) return abortWith(copyError(result.error));
      const etag = etagIn(result.data);
      if (!etag) return abortWith(incompleteResponse("ETag"));
      parts.push({ partNumber, etag });
    }
    const completed = await driver.completeMultipart(to, uploadId, parts);
    return completed.error ? abortWith(completed.error) : completed;
  }

  const driver: StorageDriver = {
    rules,
    publicUrl,

    async presignPut(key, given) {
      const options = orEmpty(given);
      const problem =
        keyProblem(key) ??
        objectOptionsProblem(options) ??
        checksumProblem(options.checksumCrc32c) ??
        sizeProblem(options.size, rules.maxSinglePutSize) ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds);
      if (problem) return fail(invalidInput(problem));
      return ok(await presign(objectUrl(key), writeHeaders(options), options.size, options.expiresIn));
    },

    async createMultipart(key, given) {
      const options = orEmpty(given);
      const problem = keyProblem(key) ?? objectOptionsProblem(options);
      if (problem) return fail(invalidInput(problem));
      return startMultipart(key, options);
    },

    async presignPart(key, uploadId, partNumber, given) {
      const options = orEmpty(given);
      const problem =
        keyProblem(key) ??
        uploadIdProblem(uploadId) ??
        partNumberProblem(partNumber, rules.maxParts) ??
        checksumProblem(options.checksumCrc32c) ??
        sizeProblem(options.size, rules.maxPartSize, "part") ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds);
      if (problem) return fail(invalidInput(problem));
      const headers: Record<string, string> = options.checksumCrc32c
        ? { "x-amz-checksum-crc32c": options.checksumCrc32c }
        : {};
      const url = objectUrl(key, { partNumber: String(partNumber), uploadId });
      return ok(await presign(url, headers, options.size, options.expiresIn));
    },

    async presignGet(key, given) {
      const options = orEmpty(given);
      const signedAt = options.signedAt ?? now();
      const problem =
        keyProblem(key) ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds) ??
        objectOptionsProblem({ disposition: options.disposition }) ??
        (signedAt instanceof Date &&
        signedAt.getTime() >= 0 &&
        signedAt.getTime() + options.expiresIn * 1000 < SIGNABLE_UNTIL_MS
          ? null
          : "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.");
      if (problem) return fail(invalidInput(problem));
      const query: Record<string, string> = options.disposition
        ? { "response-content-disposition": options.disposition }
        : {};
      const url = await presignUrl({
        method: "GET",
        url: objectUrl(key, query),
        credentials,
        region,
        date: signedAt,
        expiresIn: options.expiresIn,
      });
      return ok({ url: url.toString(), expiresAt: new Date(signedAt.getTime() + options.expiresIn * 1000) });
    },

    async getBucketCors() {
      const result = await sendForXml("GET", new URL(`${bucketUrl}?cors=`));
      if (result.error) return configurationReadError(result.error, "NoSuchCORSConfiguration", "CORS");
      // A 200 without the element is not "no rules" (a proxy's HTML page, say): checkBucket would report a missing rule.
      const configuration = xmlBlocks(result.data, "CORSConfiguration")[0];
      if (configuration === undefined) return fail(incompleteResponse("CORS configuration"));
      return ok(
        xmlBlocks(configuration, "CORSRule").map((rule) => ({
          allowedOrigins: xmlTexts(rule, "AllowedOrigin"),
          allowedMethods: xmlTexts(rule, "AllowedMethod"),
          allowedHeaders: xmlTexts(rule, "AllowedHeader"),
          exposeHeaders: xmlTexts(rule, "ExposeHeader"),
        })),
      );
    },

    async getBucketLifecycle() {
      const result = await sendForXml("GET", new URL(`${bucketUrl}?lifecycle=`));
      if (result.error) return configurationReadError(result.error, "NoSuchLifecycleConfiguration", "lifecycle");
      const configuration = xmlBlocks(result.data, "LifecycleConfiguration")[0];
      if (configuration === undefined) return fail(incompleteResponse("lifecycle configuration"));
      const parsed: BucketLifecycleRule[] = [];
      for (const rule of xmlBlocks(configuration, "Rule")) {
        const days = xmlText(xmlBlocks(rule, "AbortIncompleteMultipartUpload")[0] ?? "", "DaysAfterInitiation");
        if (days !== undefined && !/^\d{1,9}$/.test(days))
          return fail(incompleteResponse("valid multipart abort days"));
        parsed.push({
          id: xmlText(rule, "ID") ?? "",
          enabled: xmlText(rule, "Status") === "Enabled",
          prefix: xmlText(rule, "Prefix") ?? "",
          ...(days === undefined ? {} : { abortIncompleteMultipartUploadDays: Number(days) }),
        });
      }
      return ok(parsed);
    },

    async listParts(key, uploadId) {
      const problem = keyProblem(key) ?? uploadIdProblem(uploadId);
      if (problem) return fail(invalidInput(problem));
      const parts: PartInfo[] = [];
      let marker = "0";
      let truncated = true;
      while (truncated) {
        const result = await sendForXml(
          "GET",
          objectUrl(key, { uploadId, "max-parts": String(MAX_LIST_PAGE), "part-number-marker": marker }),
        );
        if (result.error) return result;
        for (const block of xmlBlocks(result.data, "Part")) {
          parts.push({
            partNumber: Number(xmlText(block, "PartNumber")),
            size: Number(xmlText(block, "Size")),
            etag: etagIn(block),
            checksumCrc32c: xmlText(block, "ChecksumCRC32C"),
          });
        }
        truncated = xmlText(result.data, "IsTruncated") === "true";
        const next = xmlText(result.data, "NextPartNumberMarker") ?? "";
        // A missing or non-advancing marker would loop forever.
        if (truncated && !(Number(next) > Number(marker))) return fail(incompleteResponse("valid next part marker"));
        marker = next;
      }
      return ok(parts);
    },

    async completeMultipart(key, uploadId, parts, given) {
      const options = orEmpty(given);
      const problem = keyProblem(key) ?? uploadIdProblem(uploadId) ?? partsProblem(parts, rules.maxParts);
      if (problem) return fail(invalidInput(problem));
      const xml = parts
        .toSorted((a, b) => a.partNumber - b.partNumber)
        // A browser reads the part's ETag header with its quotes; quoting it again would name another ETag.
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${escapeXml(stripQuotes(part.etag))}"</ETag></Part>`,
        )
        .join("");
      const result = await sendForXml("POST", objectUrl(key, { uploadId }), {
        headers: options.ifNoneMatch ? { "if-none-match": "*" } : {},
        body: encoder.encode(`<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`),
        timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
      });
      if (result.error) return result;
      const etag = etagIn(result.data);
      return etag ? ok({ etag }) : fail(incompleteResponse("ETag"));
    },

    async abortMultipart(key, uploadId) {
      const problem = keyProblem(key) ?? uploadIdProblem(uploadId);
      if (problem) return fail(invalidInput(problem));
      const result = await send("DELETE", objectUrl(key, { uploadId }));
      if (result.error && result.error.code !== "NO_SUCH_UPLOAD") return result;
      return ok(undefined);
    },

    async head(key) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send("HEAD", objectUrl(key), { headers: { "x-amz-checksum-mode": "ENABLED" } });
      if (result.error) return result.error.code === "NOT_FOUND" ? ok(null) : result;
      // A missing size would read as an empty object, and a copy would then copy nothing. A missing ETag would make a
      // copy send an empty x-amz-copy-source-if-match.
      if (!result.data.headers.has("content-length")) return fail(incompleteResponse("content length"));
      const info = readObjectInfo(key, result.data.headers);
      if (info.etag === "") return fail(incompleteResponse("ETag"));
      return ok(info);
    },

    async getRange(key, start, end) {
      const problem = keyProblem(key) ?? rangeProblem(start, end);
      if (problem) return fail(invalidInput(problem));
      const result = await send("GET", objectUrl(key), { headers: { range: `bytes=${start}-${end}` } });
      if (result.error) return result;
      return ok(result.data.body);
    },

    async put(key, body, given) {
      const options = orEmpty(given);
      const problem =
        keyProblem(key) ??
        bodyProblem(body) ??
        objectOptionsProblem(options) ??
        checksumProblem(options.checksumCrc32c);
      if (problem) return fail(invalidInput(problem));
      const payload =
        typeof body === "string" ? encoder.encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      const size = payload instanceof Blob ? payload.size : payload.length;
      const tooLarge = sizeProblem(size, rules.maxSinglePutSize);
      if (tooLarge) return fail(invalidInput(tooLarge));
      const result = await send("PUT", objectUrl(key), {
        headers: writeHeaders(options),
        body: payload,
        // Assumes the link to the storage moves at least 1 MiB/s.
        timeoutMs: REQUEST_TIMEOUT_MS + Math.ceil(size / MiB) * 1000,
      });
      if (result.error) return result;
      return ok({ etag: stripQuotes(result.data.headers.get("etag") ?? "") });
    },

    async copy(from, to) {
      const problem = keyProblem(from) ?? keyProblem(to);
      if (problem) return fail(invalidInput(problem));
      const source = await driver.head(from);
      if (source.error) return source;
      if (!source.data) {
        return fail(new CloudropError("NOT_FOUND", "The object to copy does not exist. Check the source key."));
      }
      // `/bucket/key` without the endpoint's path prefix: the source is named inside the storage service.
      const copyHeaders = {
        "x-amz-copy-source": `/${encodeRfc3986(config.bucket)}/${encodeKeyPath(from)}`,
        // Without it, a source overwritten during a multipart copy would leave parts of both versions in the copy.
        "x-amz-copy-source-if-match": `"${source.data.etag}"`,
      };
      if (source.data.size > rules.maxSinglePutSize) return copyInParts(source.data, copyHeaders, to);
      const result = await sendForXml("PUT", objectUrl(to), {
        headers: copyHeaders,
        timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
      });
      if (result.error) return fail(copyError(result.error));
      const etag = etagIn(result.data);
      return etag ? ok({ etag }) : fail(incompleteResponse("ETag"));
    },

    async delete(key) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send("DELETE", objectUrl(key));
      if (result.error && result.error.code !== "NOT_FOUND") return result;
      return ok(undefined);
    },

    async deleteMany(keys) {
      const problem = keyListProblem(keys);
      if (problem) return fail(invalidInput(problem));
      const deleted: string[] = [];
      const failed: { key: string; error: CloudropError }[] = [];
      await forEachConcurrently(keys, DELETE_CONCURRENCY, async (key) => {
        const result = await driver.delete(key);
        if (result.error) failed.push({ key, error: result.error });
        else deleted.push(key);
      });
      return ok({ deleted, failed });
    },

    async list(prefix, given) {
      const { cursor, limit = MAX_LIST_PAGE } = orEmpty(given);
      const problem =
        prefixProblem(prefix) ?? limitProblem(limit) ?? (cursor === undefined ? null : cursorProblem(cursor));
      if (problem) return fail(invalidInput(problem));
      const url = new URL(bucketUrl);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", String(limit));
      if (cursor !== undefined) url.searchParams.set("continuation-token", cursor);
      const result = await sendForXml("GET", url);
      if (result.error) return result;
      const items = xmlBlocks(result.data, "Contents").map((block) => ({
        key: xmlText(block, "Key") ?? "",
        size: Number(xmlText(block, "Size")),
        etag: etagIn(block),
        uploadedAt: new Date(xmlText(block, "LastModified") ?? 0),
      }));
      if (xmlText(result.data, "IsTruncated") !== "true") return ok({ items, nextCursor: null });
      // Ending the listing here would silently skip the rest of the prefix.
      const nextCursor = xmlText(result.data, "NextContinuationToken");
      return nextCursor ? ok({ items, nextCursor }) : fail(incompleteResponse("continuation token"));
    },
  };

  return driver;
}
