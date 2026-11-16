// The client's calls to the four server endpoints (spec §5). Each answer is checked before it is used (decision S16).

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type {
  CompleteResponse,
  Endpoint,
  ErrorBody,
  MultipartTicket,
  SignedPart,
  SignedRequest,
  SingleTicket,
  UploadRequest,
} from "../protocol/types.ts";
import { readCompleted, readErrorBody, readSignedParts, readSignedRequest, readTicket } from "./answers.ts";
import { aborted, serverBusy, serverUnreachable, unreadableAnswer } from "./failures.ts";
import { parseRetryAfter, waitAtLeast } from "./retry.ts";

/** How the client sends every request: the endpoints' POSTs and the bucket's PUTs. */
export type ClientFetch = (url: string, init: RequestInit) => Promise<Response>;

export type Ticket = SingleTicket | MultipartTicket;

export interface Endpoints {
  /** POST /upload for one file; a rejected ticket becomes its error. */
  start(route: string, file: File, metadata: unknown, signal: AbortSignal): Promise<Result<Ticket>>;
  /** POST /sign { token }: a new URL for a single PUT. */
  signSingle(token: string, signal: AbortSignal): Promise<Result<SignedRequest>>;
  /** POST /sign { token, parts }: one URL per asked part, nothing else. */
  signParts(token: string, parts: readonly number[], signal: AbortSignal): Promise<Result<SignedPart[]>>;
  /** POST /complete { token }, without the caller's signal: a cancel must not cut off a /complete the server may finish. */
  complete(token: string): Promise<Result<CompleteResponse<unknown>>>;
  /**
   * POST /abort { token }, once, with keepalive so a closing tab still delivers it; never rejects, gives up after
   * ABORT_TIMEOUT_MS (10 s); the answer ({ id }) is ignored.
   */
  abort(token: string): Promise<void>;
}

/** So a server that never answers cannot hold a cancelled upload() open. */
const ABORT_TIMEOUT_MS = 10_000;

/** The parsed body, or undefined (which JSON never is) when it is not JSON: every reader refuses it. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A non-2xx answer without cloudrop's error body. A 429 page says the cause is load, not a wrong basePath (S-7). */
const refusal = (status: number): CloudropError => (status === 429 ? serverBusy() : unreadableAnswer(status));

const toError = (body: ErrorBody): CloudropError =>
  new CloudropError(body.code, body.message, { retryable: body.retryable, parts: body.parts });

export function createEndpoints(basePath: string, fetch: ClientFetch): Endpoints {
  /** POSTs `body` as JSON and reads a 2xx answer with `read`. Never rejects. */
  async function post<T>(
    endpoint: Endpoint,
    body: unknown,
    { signal, keepalive }: { signal?: AbortSignal; keepalive?: boolean },
    read: (json: unknown) => T | null,
  ): Promise<Result<T>> {
    let response: Response;
    let text: string;
    try {
      // "include": a page on a trusted origin sends its session cookie, which authorize may read (S8).
      response = await fetch(`${basePath}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal,
        keepalive,
      });
      // A body cut off on the way counts as no answer: for /complete, the server may have finished.
      text = await response.text();
    } catch {
      return fail(signal?.aborted ? aborted() : serverUnreachable());
    }
    const json = parseJson(text);
    if (!response.ok) {
      const body = readErrorBody(json);
      const error = body ? toError(body) : refusal(response.status);
      return fail(waitAtLeast(error, parseRetryAfter(response.headers.get("retry-after"))));
    }
    const data = read(json);
    return data === null ? fail(unreadableAnswer(response.status)) : ok(data);
  }

  return {
    async start(route, file, metadata, signal) {
      // JSON.stringify leaves out a metadata of undefined, as UploadRequest's optional field allows.
      const request: UploadRequest = {
        route,
        files: [{ name: file.name, size: file.size, type: file.type }],
        metadata,
      };
      const answer = await post("upload", request, { signal }, (json) => readTicket(json, file));
      if (answer.error) return answer;
      return "kind" in answer.data ? ok(answer.data) : fail(toError(answer.data));
    },
    signSingle: (token, signal) => post("sign", { token }, { signal }, readSignedRequest),
    signParts: (token, parts, signal) =>
      post("sign", { token, parts }, { signal }, (json) => readSignedParts(json, parts)),
    complete: (token) => post("complete", { token }, {}, readCompleted),
    async abort(token) {
      try {
        // The body is a token, far under the 64 KiB a browser allows keepalive requests.
        await post("abort", { token }, { signal: AbortSignal.timeout(ABORT_TIMEOUT_MS), keepalive: true }, () => true);
      } catch {
        // A failed /abort changes nothing for a cancelled upload; the lifecycle rule cleans up.
      }
    },
  };
}
