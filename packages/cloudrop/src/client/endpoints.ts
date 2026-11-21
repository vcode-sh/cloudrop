// The client's calls to the four server endpoints (spec §5). Each answer is checked before it is used (decision S16).

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import {
  ACCOUNT_HEADER,
  type CompleteResponse,
  type Endpoint,
  type ErrorBody,
  type MultipartTicket,
  type SignedPart,
  type SignedRequest,
  type SingleTicket,
  type UploadRequest,
} from "../protocol/types.ts";
import { type Account, encodeAccount } from "./account.ts";
import { readCompleted, readErrorBody, readSignedParts, readSignedRequest, readTickets } from "./answers.ts";
import { aborted, accountFailed, headersFailed, serverBusy, serverUnreachable, unreadableAnswer } from "./failures.ts";
import { createKeepaliveBudget } from "./keepalive.ts";
import { parseRetryAfter, waitAtLeast } from "./retry.ts";

/** How the client sends every request: the endpoints' POSTs and the bucket's PUTs. */
export type ClientFetch = (url: string, init: RequestInit) => Promise<Response>;

export type Ticket = SingleTicket | MultipartTicket;

/** Headers for the upload server only, or a function, possibly async, that gives them before each request (M8-L5). */
export type ServerHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export interface Endpoints {
  /**
   * POST /upload for every file at once: one entry per file, in order; a rejected file is its error, which carries the
   * answer's Retry-After (M3-U92). `idempotencyKey` names the ask: every retry of one ask sends the same.
   */
  start(
    route: string,
    files: readonly File[],
    metadata: unknown,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<Result<(Ticket | CloudropError)[]>>;
  /** POST /sign { token }: a new URL for a single PUT. */
  signSingle(token: string, signal: AbortSignal): Promise<Result<SignedRequest>>;
  /** POST /sign { token, parts }: one URL per asked part, nothing else. */
  signParts(token: string, parts: readonly number[], signal: AbortSignal): Promise<Result<SignedPart[]>>;
  /** POST /complete { token }, without the caller's signal: a cancel must not cut off a /complete the server may finish. */
  complete(token: string): Promise<Result<CompleteResponse<unknown>>>;
  /**
   * POST /abort { token }, once, with keepalive so a closing tab still delivers it, while the keepalive budget lasts
   * (M11-R87); never rejects. `keep` asks the server to keep an object that landed: discard() sends it (M3-U94), and
   * so does a ticket whose doubt the server ended (M11-R201). `awaited` sends without keepalive: discard() alone, which
   * a live page waits for and whose result it reads (M3-U93, M3-U95). The answer's id is ignored.
   */
  abort(token: string, options?: { keep?: boolean; awaited?: boolean }): Promise<Result<true>>;
}

// How long each call may wait for its whole answer, so a server that never answers cannot hold a file queued,
// completing or cancelling for good (M4-F3). /complete may list 10,000 parts, which the server verifies first.
const ASK_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 120_000;
const ABORT_TIMEOUT_MS = 10_000;

/** The parsed body, or undefined (which JSON never is) when it is not JSON: every reader refuses it. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Older React Native's AbortSignal polyfill has only `aborted` and the abort event: no throwIfAborted, no reason.
const cancelled = () => new Error("The request was cancelled or timed out before it was sent.");

/** Rejects when `signal` fires, so a headers function that never settles cannot hold a request past its timeout. */
const rejectOnAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(cancelled()), { once: true });
    if (signal.aborted) reject(cancelled());
  });

/** `given` with names in lower case, as Headers keeps them, and the client's content-type last: it cannot be replaced. */
const jsonHeaders = (given?: HeadersInit): Record<string, string> => ({
  ...Object.fromEntries(new Headers(given)),
  "content-type": "application/json",
});

/** A non-2xx answer without cloudrop's error body. A 429 page says the cause is load, not a wrong basePath (S-7). */
const refusal = (status: number): CloudropError => (status === 429 ? serverBusy() : unreadableAnswer(status));

interface PostOptions {
  signal?: AbortSignal;
  keepalive?: boolean;
  timeoutMs?: number;
}

// The body's retryable, parts and content are the error's options.
const toError = (body: ErrorBody): CloudropError => new CloudropError(body.code, body.message, body);

export function createEndpoints(
  basePath: string,
  fetch: ClientFetch,
  { headers: serverHeaders, account }: { headers?: ServerHeaders; account?: Account } = {},
): Endpoints {
  // Built once, so without a function no request waits before fetch: pagehide's keepalive /abort is sent within the
  // event (M3-U33).
  const fixedHeaders = jsonHeaders(typeof serverHeaders === "function" ? undefined : serverHeaders);
  const budget = createKeepaliveBudget();
  /** The account header of an /upload, after the app's headers so that it wins; none for null or undefined. */
  async function accountHeader(signal: AbortSignal): Promise<Record<string, string>> {
    const value = typeof account === "function" ? await Promise.race([account(), rejectOnAbort(signal)]) : account;
    if (value === null || value === undefined) return {};
    const encoded = encodeAccount(value);
    if (encoded === null) throw new TypeError("The account function returned neither a user's id nor null.");
    return { [ACCOUNT_HEADER]: encoded };
  }
  /**
   * POSTs `body` as JSON and reads the whole answer within `timeoutMs`. Never rejects: no whole answer in time is
   * NETWORK_ERROR, as no answer is; ABORTED only when `signal` fired.
   */
  async function send(
    endpoint: Endpoint,
    body: unknown,
    { signal, keepalive, timeoutMs = ASK_TIMEOUT_MS }: PostOptions,
  ): Promise<Result<{ response: Response; text: string }>> {
    // Without AbortSignal.any (ruling M3-U16): one controller that the timeout and the caller's signal both abort.
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timeout = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    // What a failure means depends on how far the request got: no headers, no account, or no answer.
    let failure: (cause: unknown) => CloudropError = headersFailed;
    let reserved = 0;
    try {
      // A request cancelled before it starts calls no headers function, which may refresh a token over the network.
      if (controller.signal.aborted) throw cancelled();
      // Inside the timeout and the caller's signal (M8-L6).
      const given =
        typeof serverHeaders === "function"
          ? jsonHeaders(await Promise.race([serverHeaders(), rejectOnAbort(controller.signal)]))
          : fixedHeaders;
      failure = accountFailed;
      const headers = endpoint === "upload" ? { ...given, ...(await accountHeader(controller.signal)) } : given;
      failure = serverUnreachable;
      const text = JSON.stringify(body);
      // Beyond the budget the request goes without keepalive: sent while the page lives, which one the browser refuses
      // is not (M11-R87). A token is ASCII, so the text's length is its bytes.
      reserved = budget.take(keepalive, text.length);
      // "include": a page on a trusted origin sends its session cookie, which authorize may read (S8).
      const response = await fetch(`${basePath}/${endpoint}`, {
        method: "POST",
        headers,
        body: text,
        credentials: "include",
        signal: controller.signal,
        keepalive: reserved > 0,
      });
      // A body cut off on the way counts as no answer: for /complete, the server may have finished.
      return ok({ response, text: await response.text() });
    } catch (cause) {
      return fail(signal?.aborted ? aborted() : failure(cause));
    } finally {
      budget.give(reserved);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
    }
  }

  /** As send(), then reads a 2xx answer with `read`. Never rejects. */
  async function post<T>(
    endpoint: Endpoint,
    body: unknown,
    options: PostOptions,
    read: (json: unknown, retryAfterMs: number) => T | null,
  ): Promise<Result<T>> {
    const sent = await send(endpoint, body, options);
    if (sent.error) return sent;
    const { response, text } = sent.data;
    const json = parseJson(text);
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (!response.ok) {
      const body = readErrorBody(json);
      return fail(waitAtLeast(body ? toError(body) : refusal(response.status), retryAfterMs));
    }
    const data = read(json, retryAfterMs);
    return data === null ? fail(unreadableAnswer(response.status)) : ok(data);
  }

  return {
    start(route, files, metadata, idempotencyKey, signal) {
      // JSON.stringify leaves out a metadata of undefined, as UploadRequest's optional field allows.
      const request: UploadRequest = {
        route,
        files: files.map(({ name, size, type }) => ({ name, size, type })),
        metadata,
        idempotencyKey,
      };
      return post(
        "upload",
        request,
        { signal },
        (json, retryAfterMs) =>
          readTickets(json, files)?.map((ticket) =>
            "kind" in ticket ? ticket : waitAtLeast(toError(ticket), retryAfterMs),
          ) ?? null,
      );
    },
    signSingle: (token, signal) => post("sign", { token }, { signal }, readSignedRequest),
    signParts: (token, parts, signal) =>
      post("sign", { token, parts }, { signal }, (json) => readSignedParts(json, parts)),
    complete: (token) => post("complete", { token }, { timeoutMs: COMPLETE_TIMEOUT_MS }, readCompleted),
    // A failed /abort changes nothing for a cancelled upload; the lifecycle rule cleans up. discard(), which a live page
    // awaits and may run for many uploads at once, sends without keepalive (M3-U95) and so leaves the budget to cancels.
    abort: (token, { keep, awaited } = {}) =>
      // A `keep` that is not set stays out of the body, as JSON leaves out undefined.
      post(
        "abort",
        { token, keep: keep || undefined },
        { keepalive: !awaited, timeoutMs: ABORT_TIMEOUT_MS },
        () => true,
      ),
  };
}
