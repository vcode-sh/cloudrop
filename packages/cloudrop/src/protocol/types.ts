// The upload protocol (spec §5): the only module the client and the server share. Types, constants and one guard
// both sides read the wire with, so the client bundle never pulls in server code.

import type { CloudropErrorCode, ContentRefusal, RefusedKind } from "../errors.ts";

/** The four JSON endpoints, each at `<basePath>/<endpoint>`, all `POST`. */
export type Endpoint = "upload" | "sign" | "complete" | "abort";

/** The largest request body any endpoint reads, in bytes (spec §7.3). */
export const MAX_BODY_BYTES: number = 65_536;
/**
 * The header that carries the client's `account` option, percent-encoded, with `/upload` only. On a route with a store
 * and `owner`, the server refuses the upload with ACCOUNT_CHANGED when it names another owner (M10-A).
 */
export const ACCOUNT_HEADER = "x-cloudrop-account";
/** The most part URLs one `/upload` file or one `/sign` call returns (spec §5.2). */
export const PARTS_PER_SIGN: number = 20;
/** The longest file name accepted, in Unicode code points (spec §7.3). */
export const MAX_NAME_LENGTH: number = 255;

/** What the client knows about a file before it uploads it. `type` may be "" (the browser does not know it). */
export interface FileDescriptor {
  name: string;
  size: number;
  type: string;
}

export interface UploadRequest {
  route: string;
  files: FileDescriptor[];
  metadata?: unknown;
  /**
   * 16 to 128 characters of `[A-Za-z0-9_-]`, new for each ask and the same on every retry of it. With a store, a
   * retry supersedes the rows its earlier attempt reserved, whose answer the client never had. Never reuse a key for a
   * new ask: a request with a key ends the pending uploads of earlier requests with the same key, route and owner. On
   * a route without `owner`, or when it answers null, the key does nothing.
   */
  idempotencyKey?: string;
}

/**
 * A presigned `PUT`. Send exactly `headers`, no more: every header is signed, and R2 rejects an unsigned
 * `x-amz-meta-*` header. Never set Content-Length: its value is signed, and the platform derives it from the body.
 */
export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  /** ISO 8601. Renew through `/sign` before it passes. */
  expiresAt: string;
}

export interface SignedPart extends SignedRequest {
  partNumber: number;
}

interface TicketFields {
  id: string;
  key: string;
  /** Present it to `/sign`, `/complete` and `/abort`. */
  token: string;
  /** ISO 8601: when the token, and with it the chance to resume, expires. */
  expiresAt: string;
}

export interface SingleTicket extends TicketFields {
  kind: "single";
  put: SignedRequest;
}

export interface MultipartTicket extends TicketFields {
  kind: "multipart";
  /** Every part except the last has exactly this many bytes. */
  partSize: number;
  partCount: number;
  /** URLs for the first parts, at most PARTS_PER_SIGN; ask `/sign` for the rest. */
  parts: SignedPart[];
}

/** A file the server refused (size, type, or a storage failure); the request's other files go on. */
export interface RejectedFile {
  kind: "rejected";
  error: ErrorBody;
}

export type FileTicket = SingleTicket | MultipartTicket | RejectedFile;

/** One ticket per requested file, in request order. */
export interface UploadResponse {
  files: FileTicket[];
}

/** `parts` is required for a multipart upload and must be absent for a single PUT. */
export interface SignRequest {
  token: string;
  parts?: number[];
}

export type SignResponse = { put: SignedRequest } | { parts: SignedPart[] };

export interface CompleteRequest {
  token: string;
}

export interface UploadedFile {
  /** Stable across retries and copies; stored as `x-amz-meta-cloudrop-id`. */
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  /** The public URL on a public route, otherwise null (use `api.getUrl`). */
  url: string | null;
}

export interface CompleteResponse<TResult = unknown> {
  file: UploadedFile;
  /** What the route's `onComplete` returned, or null without one. */
  data: TResult;
}

export interface AbortRequest {
  token: string;
  /**
   * Without a store's row, never delete an object that landed, even while the token is valid: only an unfinished
   * multipart upload is aborted. With a row it changes nothing: a pending row proves no completion committed, and a
   * completed one is kept anyway. The client's discard() sends it, for an upload a /complete may have finished.
   */
  keep?: boolean;
}

export interface AbortResponse {
  id: string;
}

export interface ErrorBody {
  code: CloudropErrorCode;
  message: string;
  retryable: boolean;
  /** PARTS_MISSING only: the part numbers to upload again. */
  parts?: number[];
  /** FILE_TYPE_NOT_ALLOWED from a type check only: what it found in the file. */
  content?: ContentRefusal;
}

// A record, so a kind added to RefusedKind and not here fails to compile.
const REFUSED_KINDS: Readonly<Record<RefusedKind, true>> = {
  "web-page": true,
  program: true,
  installer: true,
  script: true,
  svg: true,
  xml: true,
  denied: true,
};

/** Whether `value` is a RefusedKind: the server sends and the client keeps only a kind of the closed set (M12-E6). */
export const isRefusedKind = (value: unknown): value is RefusedKind =>
  typeof value === "string" && Object.hasOwn(REFUSED_KINDS, value);

/** Every non-2xx response has this body. */
export interface ErrorResponse {
  error: ErrorBody;
}

/**
 * Approximately what a value becomes after JSON.stringify and JSON.parse, for JSON-shaped data such as an authorize
 * result or schema output: a `toJSON` value (a Date) becomes its JSON form, and function, symbol and undefined
 * properties vanish. It does not model every JavaScript object: in arrays JSON turns undefined and functions into
 * null, a `T | undefined` property is typed as present though JSON may drop it, and a Map, a Set or a class instance is
 * typed by its own fields while JSON keeps only own enumerable properties (a Map becomes `{}`). Return plain data.
 */
// T is only ever the type being checked, never the one it is checked against, so TypeScript relates Jsonified<A> to
// Jsonified<B> whenever A relates to B: a plugin for { userId } is checked against the routes' results (M12-T5).
// `unknown` reaches the last branch and stays unknown.
export type Jsonified<T> = T extends { toJSON(): infer J }
  ? Jsonified<J>
  : T extends string | number | boolean | null
    ? T
    : // void, not undefined: it covers undefined too, and an onComplete that returns nothing has the result void, which
      // would otherwise reach the `unknown` branch.
      T extends void
      ? never
      : T extends symbol | bigint | ((...args: never[]) => unknown)
        ? never
        : T extends readonly (infer E)[]
          ? Jsonified<E>[]
          : T extends object
            ? {
                [K in keyof T as K extends string | number
                  ? Jsonified<T[K]> extends never
                    ? never
                    : K
                  : never]: Jsonified<T[K]>;
              }
            : unknown;

/** The types the client reads from a route. */
export interface RouteTypes {
  metadata: unknown;
  result: unknown;
}

/** Implemented by the server's `Cloudrop`. The client reads it through `import type` only. */
export interface InferableCloudrop<TRoutes extends Record<string, RouteTypes> = Record<string, RouteTypes>> {
  /** Type-only: never set at runtime. */
  readonly "~routes"?: TRoutes;
}

type RoutesOf<TCloudrop> = TCloudrop extends InferableCloudrop<infer TRoutes> ? TRoutes : never;

export type RouteName<TCloudrop> = keyof RoutesOf<TCloudrop> & string;

/** The metadata a client sends to the route: the schema's input type, or undefined for a route without a schema. */
export type RouteMetadata<TCloudrop, TName extends RouteName<TCloudrop>> = RoutesOf<TCloudrop>[TName]["metadata"];

/** What `/complete` returns as `data` for the route: the JSON form of its `onComplete` result. */
export type RouteResult<TCloudrop, TName extends RouteName<TCloudrop>> = RoutesOf<TCloudrop>[TName]["result"];

/** What both framework adapters accept: anything with a Web `Request` handler, such as `Cloudrop`. */
export interface RequestHandler {
  handler(request: Request): Promise<Response>;
}
