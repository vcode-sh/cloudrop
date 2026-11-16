// The shape checks for the four endpoints' answers (decision S16). The server is trusted, but the answer may come from
// a proxy, a wrong basePath or another cloudrop version: each reader returns its typed value, or null for any other
// shape, so a bad answer becomes an error instead of a TypeError deep in the upload.

import type { CloudropErrorCode } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import { countParts } from "../plan.ts";
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

function readError(value: unknown): ErrorBody | null {
  if (!isPlainObject(value)) return null;
  const { code, message, retryable, parts } = value;
  if (!isString(code) || !isString(message) || typeof retryable !== "boolean") return null;
  // A code this client does not know passes through: a newer server may send one, and `message` still explains it.
  const body = { code: code as CloudropErrorCode, message, retryable };
  return Array.isArray(parts) && parts.every(isCount) ? { ...body, parts } : body;
}

/** The one ticket of a one-file /upload: a single or multipart ticket, or the error body of a rejected file. */
export function readTicket(json: unknown, file: File): Ticket | ErrorBody | null {
  if (!isPlainObject(json) || !Array.isArray(json.files) || json.files.length !== 1) return null;
  const [ticket] = json.files;
  if (isSingle(ticket) || isMultipart(ticket, file.size)) return ticket;
  return isPlainObject(ticket) && ticket.kind === "rejected" ? readError(ticket.error) : null;
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

/** `{ error }` of a non-2xx answer; `parts`, when it is not a list of part numbers, is dropped. */
export function readErrorBody(json: unknown): ErrorBody | null {
  return isPlainObject(json) ? readError(json.error) : null;
}
