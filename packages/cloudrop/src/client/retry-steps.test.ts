// Contract: M11-R80's table through the real client. retry() of a failed file that holds a ticket does what the file's
// error leaves possible: the same ticket when the request, not the upload, failed; the bytes again on the same ticket
// when the server found them missing; a new ticket from /upload when the server ended the upload or the bucket refused
// it. One row per answer the server gives at /sign and /complete and the bucket gives a PUT. Oracle: the requests the
// retry sent, and whether the file ended under the first ticket's key or a new one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { CloudropErrorCode } from "../errors.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

/** A client whose requests `fault` answers while `failing`; /upload always reaches the server, and its keys are kept. */
function setup(fault: Fault) {
  const state = { failing: true, keys: [] as string[] };
  const fixture = clientFixture(
    { files },
    {
      fault: async (call) => {
        if (call.label !== "POST /upload") return state.failing ? fault(call) : undefined;
        const answer = await call.forward(call.init);
        state.keys.push((await answer.clone().json()).files[0].key);
        return answer;
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
  return { fixture, state, client };
}

const file = () => new File([offsetBytes(1000)], "a.bin", { type: "application/octet-stream" });
/** The server's answer for `code`, as errorResponse in server/http.ts sends it. */
const refusal = (code: string, status: number, retryable = false) =>
  Response.json({ error: { code, message: `The server answered ${code}.`, retryable } }, { status });
const expiredUrl = () => errorResponse(403, "ExpiredRequest", "Request has expired.");

/** Fails a one-file job with `fault`, lifts the fault, retries once: the first error, the retry's requests, the key. */
async function retried(fault: Fault) {
  const { fixture, state, client } = setup(fault);
  const job = client.start("files", file());
  const first = await job.done;
  state.failing = false;
  const before = fixture.requests.length;
  const outcome = await job.files[0]?.retry();
  const key = outcome?.status === "done" ? outcome.result.file.key : null;
  return {
    first: first.error?.code,
    sent: fixture.requests.slice(before),
    key: key === state.keys[0] ? "first" : key === state.keys[1] ? "new" : key,
  };
}

// What each step sends for a one-PUT file.
const SAME_COMPLETE = { sent: ["POST /complete"], key: "first" };
const SAME_PUT = { sent: ["PUT object", "POST /complete"], key: "first" };
// The old ticket is given up first (M11-R89).
const NEW = { sent: ["POST /abort", "POST /upload", "PUT object", "POST /complete"], key: "new" };

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retry after /complete answered", () => {
  it.each<{ code: CloudropErrorCode | "QUARANTINED"; status: number; retryable?: boolean; step: typeof NEW }>([
    // The request was refused or failed, not the upload: the object is stored, so only /complete is sent again.
    { code: "INVALID_INPUT", status: 400, step: SAME_COMPLETE },
    { code: "ORIGIN_NOT_ALLOWED", status: 403, step: SAME_COMPLETE },
    { code: "METHOD_NOT_ALLOWED", status: 405, step: SAME_COMPLETE },
    { code: "UNSUPPORTED_MEDIA_TYPE", status: 415, step: SAME_COMPLETE },
    { code: "BODY_TOO_LARGE", status: 413, step: SAME_COMPLETE },
    { code: "NOT_FOUND", status: 404, step: SAME_COMPLETE },
    { code: "SERVER_ERROR", status: 500, step: SAME_COMPLETE },
    { code: "SERVER_ERROR", status: 500, retryable: true, step: SAME_COMPLETE },
    { code: "STORAGE_ERROR", status: 502, step: SAME_COMPLETE },
    { code: "STORAGE_ERROR", status: 502, retryable: true, step: SAME_COMPLETE },
    { code: "RATE_LIMITED", status: 503, retryable: true, step: SAME_COMPLETE },
    // The server ended the upload, or its ticket no longer works: only a new one can store the file.
    { code: "INVALID_TOKEN", status: 400, step: NEW },
    { code: "UPLOAD_EXPIRED", status: 410, step: NEW },
    { code: "UNKNOWN_ROUTE", status: 404, step: NEW },
    { code: "VERIFICATION_FAILED", status: 422, step: NEW },
    { code: "NO_SUCH_UPLOAD", status: 410, step: NEW },
    { code: "ALREADY_EXISTS", status: 409, step: NEW },
    { code: "FILE_TYPE_NOT_ALLOWED", status: 400, step: NEW },
    // A plugin's afterVerify may refuse with any code, and the server then deletes the object.
    { code: "FORBIDDEN", status: 403, step: NEW },
    { code: "UNAUTHORIZED", status: 401, step: NEW },
    { code: "QUOTA_EXCEEDED", status: 403, step: NEW },
    // A newer server's code.
    { code: "QUARANTINED", status: 400, step: NEW },
  ])("$code (retryable: $retryable) retries with $step.key ticket", async ({ code, status, retryable, step }) => {
    const result = await retried(({ label }) =>
      label === "POST /complete" ? refusal(code, status, retryable) : undefined,
    );
    expect(result).toEqual({ first: code, ...step });
  });

  it.each([
    { name: "no answer", fault: () => Promise.reject(new TypeError("Failed to fetch")), first: "NETWORK_ERROR" },
    { name: "a proxy's error page", fault: () => new Response("<html>", { status: 502 }), first: "SERVER_ERROR" },
    {
      name: "a proxy's rate-limit page",
      fault: () => new Response("slow down", { status: 429 }),
      first: "RATE_LIMITED",
    },
  ])("$name sends /complete again with the same ticket", async ({ fault, first }) => {
    const result = await retried(({ label }) => (label === "POST /complete" ? fault() : undefined));
    expect(result).toEqual({ first, ...SAME_COMPLETE });
  });
});

describe("retry after /sign answered", () => {
  // The bucket refuses the first URL as expired, so the client asks /sign for a new one, which answers `code`.
  it.each<{ code: CloudropErrorCode; status: number; retryable?: boolean; step: typeof NEW }>([
    { code: "INVALID_INPUT", status: 400, step: SAME_PUT },
    { code: "ORIGIN_NOT_ALLOWED", status: 403, step: SAME_PUT },
    { code: "NOT_FOUND", status: 404, step: SAME_PUT },
    { code: "SERVER_ERROR", status: 500, step: SAME_PUT },
    { code: "SERVER_ERROR", status: 500, retryable: true, step: SAME_PUT },
    { code: "STORAGE_ERROR", status: 502, step: SAME_PUT },
    { code: "STORAGE_ERROR", status: 502, retryable: true, step: SAME_PUT },
    { code: "RATE_LIMITED", status: 503, retryable: true, step: SAME_PUT },
    { code: "INVALID_TOKEN", status: 400, step: NEW },
    { code: "UPLOAD_EXPIRED", status: 410, step: NEW },
    { code: "UNKNOWN_ROUTE", status: 404, step: NEW },
  ])("$code (retryable: $retryable) retries with $step.key ticket", async ({ code, status, retryable, step }) => {
    const result = await retried(({ label }) => {
      if (label === "PUT object") return expiredUrl();
      return label === "POST /sign" ? refusal(code, status, retryable) : undefined;
    });
    expect(result).toEqual({ first: code, ...step });
  });
});

describe("retry after the bucket answered a PUT", () => {
  it.each([
    {
      name: "500",
      answer: () => errorResponse(500, "InternalError", "Try again."),
      first: "STORAGE_ERROR",
      step: SAME_PUT,
    },
    { name: "503", answer: () => errorResponse(503, "SlowDown", "Slow down."), first: "RATE_LIMITED", step: SAME_PUT },
    {
      name: "400 for a body the bucket stopped waiting for",
      answer: () => errorResponse(400, "RequestTimeout", "Your socket connection was not written to in time."),
      first: "STORAGE_ERROR",
      step: SAME_PUT,
    },
    {
      name: "no answer",
      answer: () => Promise.reject(new TypeError("Failed to fetch")),
      first: "NETWORK_ERROR",
      step: SAME_PUT,
    },
    {
      name: "400",
      answer: () => errorResponse(400, "EntityTooLarge", "Too large."),
      first: "UPLOAD_REJECTED",
      step: NEW,
    },
    {
      name: "403 for a bad signature",
      answer: () => errorResponse(403, "SignatureDoesNotMatch", "No."),
      first: "UPLOAD_REJECTED",
      step: NEW,
    },
    {
      name: "404 for a gone upload",
      answer: () => errorResponse(404, "NoSuchUpload", "Gone."),
      first: "NO_SUCH_UPLOAD",
      step: NEW,
    },
    { name: "501", answer: () => errorResponse(501, "NotImplemented", "No."), first: "UPLOAD_REJECTED", step: NEW },
  ])("$name ($first) retries with $step.key ticket", async ({ answer, first, step }) => {
    const result = await retried(({ label }) => (label === "PUT object" ? answer() : undefined));
    expect(result).toEqual({ first, ...step });
  });
});
