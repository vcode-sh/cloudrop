// Contract: M11-R93. The client's reading of a bucket answer to a presigned PUT (client/bucket.ts) and the storage
// layer's reading of the same answer to a request the server signs (storage/storage-error.ts) say the same thing to do,
// except where a browser's PUT differs for a recorded reason. Both tables are fed every answer below: what R2 was
// measured to answer (docs/research/r2-spike-findings.md), every row of R2's error list a PUT can meet
// (https://developers.cloudflare.com/r2/api/error-codes/, read 2026-11-21), and the S3 codes the storage layer names.
// Oracle: the two classifiers against each other, and the literal list of the differences that are meant.

import { expect, it } from "vitest";
import type { SignedRequest } from "../protocol/types.ts";
import { storageError } from "../storage/storage-error.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { putObject } from "./bucket.ts";

/** A status and its S3 code; "" for an answer without a body, as a proxy or the edge sends. */
const ANSWERS: readonly (readonly [number, string])[] = [
  [301, "PermanentRedirect"],
  [400, "AuthorizationHeaderMalformed"],
  [400, "BadDigest"],
  [400, "ClientDisconnect"],
  [400, "EntityTooLarge"],
  [400, "EntityTooSmall"],
  [400, "IncompleteBody"],
  [400, "InvalidArgument"],
  [400, "InvalidDigest"],
  [400, "InvalidObjectName"],
  [400, "InvalidPart"],
  [400, "MetadataTooLarge"],
  [400, "RequestTimeout"],
  [400, ""],
  [401, "Unauthorized"],
  [403, "AccessDenied"],
  [403, "ExpiredRequest"],
  [403, "NotEntitled"],
  [403, "RequestTimeTooSkewed"],
  [403, "SignatureDoesNotMatch"],
  [403, ""],
  [404, "NoSuchBucket"],
  [404, "NoSuchKey"],
  [404, "NoSuchUpload"],
  [408, ""],
  [409, "ConditionalRequestConflict"],
  [409, "ObjectLockedByBucketPolicy"],
  [409, "OperationAborted"],
  [411, "MissingContentLength"],
  [412, "PreconditionFailed"],
  [429, "ServiceUnavailable"],
  [429, "TooManyRequests"],
  [500, "InternalError"],
  [501, "NotImplemented"],
  [502, ""],
  [503, "ServiceUnavailable"],
  [503, "SlowDown"],
  [504, ""],
];

const target: SignedRequest = {
  url: "https://uploads.example.com/a.txt?X-Amz-Signature=0000",
  headers: { "content-type": "text/plain", "if-none-match": "*" },
  expiresAt: "2026-11-15T12:15:00.000Z",
};

const answerOf = (status: number, code: string) =>
  code ? errorResponse(status, code, "raw text") : new Response("", { status });

/**
 * What a failure says to do. A retry names its code, since RATE_LIMITED also slows the client's pool down. A refusal
 * names only NO_SUCH_UPLOAD, the one code retry() and resume() read from both sides (M9-H4): every other refusal of the
 * bucket is the client's UPLOAD_REJECTED, whatever the server calls it in its own log.
 */
const verdict = ({ code, retryable }: { code: string; retryable: boolean }) =>
  retryable ? `retry, ${code}` : code === "NO_SUCH_UPLOAD" ? "stop, NO_SUCH_UPLOAD" : "stop";

async function clientSays(status: number, code: string): Promise<string> {
  const outcome = await putObject(
    async () => answerOf(status, code),
    target,
    new Blob(["hello"]),
    new AbortController().signal,
  );
  if (outcome.kind === "retry" || outcome.kind === "rejected") return verdict(outcome.error);
  return outcome.kind === "expired" ? "renew the URL once" : outcome.kind;
}

it("reads every bucket answer as the storage layer does, but for a browser's own cases", async () => {
  const read = await Promise.all(
    ANSWERS.map(async ([status, code]) => ({
      answer: `${status} ${code}`.trim(),
      client: await clientSays(status, code),
      server: verdict(storageError(status, await answerOf(status, code).text())),
    })),
  );

  expect(read.filter(({ client, server }) => client !== server)).toEqual([
    // The server signs each request as it sends it, so its 403 is its credentials or its clock. The page holds a URL
    // signed minutes ago, which may only have expired: it asks /sign for a new one, once, and then stops too. R2 says
    // ExpiredRequest and RustFS AccessDenied for the same expiry, so the code cannot narrow it (decision S10).
    { answer: "403 AccessDenied", client: "renew the URL once", server: "stop" },
    { answer: "403 ExpiredRequest", client: "renew the URL once", server: "stop" },
    { answer: "403 NotEntitled", client: "renew the URL once", server: "stop" },
    { answer: "403 RequestTimeTooSkewed", client: "renew the URL once", server: "stop" },
    { answer: "403", client: "renew the URL once", server: "stop" },
    // The page's PUT is create-only under a key of its own, so a 412 is its own earlier attempt, which stored the
    // object and whose answer was lost (spec §5.4). /complete then checks whose object it is.
    { answer: "412 PreconditionFailed", client: "stored", server: "stop" },
  ]);
});
