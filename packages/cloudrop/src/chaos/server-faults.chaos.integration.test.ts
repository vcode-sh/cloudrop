// Chaos rows 13 and 14 (design spec §4): faults in the server's own storage calls during /complete (M3-K4). The
// server answers the client a retryable error that says nothing of the storage, logs the storage's error, and the
// client retries /complete (M3-S9) until the file is done. One more row faults the storage call of /upload (M3-U92).
// Run with `bun run test:chaos`.
import { expect, test } from "vitest";
import type { CloudropError } from "../errors.ts";
import { SLOW_DOWN } from "../testing/chaos-bodies.ts";
import { chaosFile, MULTIPART_FILE_SIZE, SINGLE_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

/** What the server logged, without the stack: the message and the storage error's classification. */
const loggedErrors = () =>
  chaos.logger.errors.map(({ message, error }) => {
    const { code, retryable, status, storageCode } = error as CloudropError;
    return { message, code, retryable, status, storageCode };
  });

test("a CompleteMultipartUpload the storage answers 503 reaches the client as a retryable RATE_LIMITED with 429, and the retried /complete finishes the file", async () => {
  chaos.proxy.set([
    {
      match: { kind: "server", operation: "CompleteMultipartUpload" },
      fault: { kind: "answer", status: 503, body: SLOW_DOWN },
    },
  ]);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 429", "POST /complete 200"]);
  expect(chaos.appErrors()).toEqual([
    {
      error: { code: "RATE_LIMITED", message: "The storage service is busy. Try again in a moment.", retryable: true },
    },
  ]);
  // The retry lists the parts again: the injected 503 never reached RustFS, so the upload was still open.
  const requests = chaos.bucketRequests();
  expect([requests[0], ...requests.slice(4)]).toEqual([
    "CreateMultipartUpload 200",
    "ListParts 200",
    "CompleteMultipartUpload 503",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  expect(requests.slice(1, 4).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 200", "PUT part 3 200"]);
  expect(loggedErrors()).toEqual([
    {
      message: "cloudrop: a storage request failed.",
      code: "RATE_LIMITED",
      retryable: true,
      status: 503,
      storageCode: "SlowDown",
    },
  ]);
});

// M3-U92: a ticket the server could not issue reaches the client as that file's retryable refusal inside a 200, and
// the client asks /upload again for that file alone, no sooner than the bucket's Retry-After, which the 200 carries
// (M12-E5). Only a multipart ticket calls the storage in /upload: a single PUT's URL is presigned in process, so the
// proxy cannot fault that path.
test("a CreateMultipartUpload the storage answers 503 refuses the file retryably, and asking /upload again after its Retry-After finishes it", async () => {
  chaos.proxy.set([
    {
      match: { kind: "server", operation: "CreateMultipartUpload" },
      fault: { kind: "answer", status: 503, body: SLOW_DOWN, headers: { "retry-after": "3" } },
    },
  ]);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const started = performance.now();
  const { data, error } = await chaos.client().upload("files", file);
  const elapsedMs = performance.now() - started;

  expect(error).toBeNull();
  // The lane's jitter is 0, so only the Retry-After of 3 seconds can hold the second /upload back this long.
  expect(elapsedMs).toBeGreaterThanOrEqual(3000);
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /upload 200", "POST /complete 200"]);
  const requests = chaos.bucketRequests();
  expect([...requests.slice(0, 2), ...requests.slice(5)]).toEqual([
    "CreateMultipartUpload 503",
    "CreateMultipartUpload 200",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  expect(requests.slice(2, 5).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 200", "PUT part 3 200"]);
  expect(loggedErrors()).toEqual([
    {
      message: "cloudrop: a storage request failed.",
      code: "RATE_LIMITED",
      retryable: true,
      status: 503,
      storageCode: "SlowDown",
    },
  ]);
});

// Audit I4: a reset of a bodiless storage call never reaches RustFS; the server's fetch fails with no answer.
const STORAGE_FAILED = {
  error: { code: "STORAGE_ERROR", message: "The storage service failed. Try again in a moment.", retryable: true },
};
const UNREACHABLE_LOGGED = {
  message: "cloudrop: a storage request failed.",
  code: "STORAGE_UNREACHABLE",
  retryable: true,
  status: undefined,
  storageCode: undefined,
};

test("a ListParts reset in /complete reaches the client as a retryable 502 STORAGE_ERROR, and the retried /complete finishes the file", async () => {
  chaos.proxy.set([{ match: { kind: "server", operation: "ListParts" }, fault: { kind: "reset", afterBytes: 0 } }]);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 502", "POST /complete 200"]);
  expect(chaos.appErrors()).toEqual([STORAGE_FAILED]);
  const requests = chaos.bucketRequests();
  expect([requests[0], ...requests.slice(4)]).toEqual([
    "CreateMultipartUpload 200",
    "ListParts reset",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  expect(requests.slice(1, 4).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 200", "PUT part 3 200"]);
  expect(loggedErrors()).toEqual([UNREACHABLE_LOGGED]);
});

// The server sends HeadObject in /complete only for a single PUT (or a multipart upload already gone), so this row
// takes a single-PUT file (audit I4).
test("a HeadObject reset in /complete reaches the client as a retryable 502 STORAGE_ERROR, and the retried /complete finishes the file", async () => {
  chaos.proxy.set([{ match: { kind: "server", operation: "HeadObject" }, fault: { kind: "reset", afterBytes: 0 } }]);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 502", "POST /complete 200"]);
  expect(chaos.appErrors()).toEqual([STORAGE_FAILED]);
  expect(chaos.bucketRequests()).toEqual(["PUT object 200", "HeadObject reset", "HeadObject 200"]);
  expect(loggedErrors()).toEqual([UNREACHABLE_LOGGED]);
});
