// The shape checks for the four endpoints' answers (decision S16). The server is trusted, but the answer may come from
// a proxy, a wrong basePath or another cloudrop version: each reader returns its typed value, or null for any other
// shape, so a bad answer becomes an error instead of a TypeError deep in the upload.

import type { CloudropErrorCode, ContentRefusal } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import { countParts } from "../part-size.ts";
import type {
  CompleteResponse,
  ErrorBody,
  MultipartTicket,
  SignedPart,
  SignedRequest,
  SingleTicket,
  UploadedFile,
} from "../protocol/types.ts";
import type { Ticket } from "./endpoints.ts";

const isString = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isCount = (value: unknown): value is number => isSafeInteger(value) && value > 0;

function isSignedRequest(value: unknown): value is SignedRequest {
  return (
    isPlainObject(value) &&
    isString(value.url) &&
    isPlainObject(value.headers) &&
    Object.values(value.headers).every(isString) &&
    isTime(value.expiresAt)
  );
}

function isSignedPart(value: unknown, isWanted: (partNumber: number) => boolean): value is SignedPart {
  return (
    isPlainObject(value) && isSafeInteger(value.partNumber) && isWanted(value.partNumber) && isSignedRequest(value)
  );
}

function hasTicketFields(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.key) &&
    isString(value.token) &&
    isTime(value.expiresAt)
  );
}

function isSingle(value: unknown): value is SingleTicket {
  return hasTicketFields(value) && value.kind === "single" && isSignedRequest(value.put);
}

function isMultipart(value: unknown, size: number): value is MultipartTicket {
  if (!hasTicketFields(value) || value.kind !== "multipart") return false;
  const { partSize, partCount, parts } = value;
  return (
    isCount(partSize) &&
    isCount(partCount) &&
    // The plan in the token decides (S7): a client that would cut the file differently must stop here.
    partCount === countParts(size, partSize) &&
    Array.isArray(parts) &&
    parts.every((part) => isSignedPart(part, (partNumber) => partNumber >= 1 && partNumber <= partCount))
  );
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.key) &&
    isString(value.name) &&
    isString(value.type) &&
    typeof value.size === "number" &&
    (value.url === null || isString(value.url))
  );
}

const isReason = (value: unknown): value is ContentRefusal["reason"] =>
  value === "mismatch" || value === "refused" || value === "not-accepted";

/**
 * A type refusal's `content` (M11-K4): its three fields and nothing else the answer holds, or undefined for any other
 * shape. A reason this client does not know drops it too, since the type promises one of three; `message` still
 * explains the refusal.
 */
function readContent(value: unknown): ContentRefusal | undefined {
  if (!isPlainObject(value)) return undefined;
  const { declared, detected, reason } = value;
  if (!isString(declared) || !isReason(reason)) return undefined;
  if (detected === undefined) return { declared, reason };
  return isString(detected) ? { declared, detected, reason } : undefined;
}

function readError(value: unknown): ErrorBody | null {
  if (!isPlainObject(value)) return null;
  const { code, message, retryable, parts } = value;
  if (!isString(code) || !isString(message) || typeof retryable !== "boolean") return null;
  // A code this client does not know passes through: a newer server may send one, and `message` still explains it.
  const body: ErrorBody = { code: code as CloudropErrorCode, message, retryable, content: readContent(value.content) };
  return Array.isArray(parts) && parts.every(isCount) ? { ...body, parts } : body;
}

function readFileTicket(value: unknown, size: number): Ticket | ErrorBody | null {
  if (isSingle(value) || isMultipart(value, size)) return value;
  return isPlainObject(value) && value.kind === "rejected" ? readError(value.error) : null;
}

/**
 * The tickets of /upload, one per file in the order sent: a single or multipart ticket, or the error body of a rejected
 * file. One that cannot be read makes the whole answer unreadable.
 */
export function readTickets(json: unknown, files: readonly File[]): (Ticket | ErrorBody)[] | null {
  if (!isPlainObject(json) || !Array.isArray(json.files) || json.files.length !== files.length) return null;
  const answers: unknown[] = json.files;
  const tickets = files.map((file, index) => readFileTicket(answers[index], file.size));
  return tickets.every((ticket) => ticket !== null) ? tickets : null;
}

/** `{ put }` of /sign for a single PUT. */
export function readSignedRequest(json: unknown): SignedRequest | null {
  return isPlainObject(json) && isSignedRequest(json.put) ? json.put : null;
}

/** `{ parts }` of /sign, holding exactly the asked part numbers, each once: a missing one would never be sent. */
export function readSignedParts(json: unknown, asked: readonly number[]): SignedPart[] | null {
  if (!isPlainObject(json) || !Array.isArray(json.parts) || json.parts.length !== asked.length) return null;
  const unanswered = new Set(asked);
  return json.parts.every((part) => isSignedPart(part, (partNumber) => unanswered.delete(partNumber)))
    ? json.parts
    : null;
}

/** `{ file, data }` of /complete; `data` is any JSON value, null without onComplete. */
export function readCompleted(json: unknown): CompleteResponse<unknown> | null {
  return isPlainObject(json) && isUploadedFile(json.file) && "data" in json
    ? { file: json.file, data: json.data }
    : null;
}

/** `{ error }` of a non-2xx answer; `parts` and `content`, when they have another shape than theirs, are dropped. */
export function readErrorBody(json: unknown): ErrorBody | null {
  return isPlainObject(json) ? readError(json.error) : null;
}
