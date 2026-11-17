// Chaos rows 13 and 14 (design spec §4): faults in the server's own storage calls during /complete (M3-K4). The
// server answers the client a retryable error that says nothing of the storage, logs the storage's error, and the
// client retries /complete (M3-S9) until the file is done. Run with `bun run test:chaos`.
import { expect, test, vi } from "vitest";
import type { CloudropError } from "../errors.ts";
import {
  type ChaosFixture,
  chaosFile,
  MULTIPART_FILE_SIZE,
  SINGLE_FILE_SIZE,
  useChaosFixture,
} from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

const SLOW_DOWN =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>';

/**
 * The bodies of the server's error answers, in order. appRequests() gives their statuses only, and these rows must
 * show the message the client got. The fixture's client reaches cloudrop.handler in process, so wrapping it reads
 * every answer without changing one. A local helper: wave-3 tasks do not edit the shared fixture.
 */
function recordErrorBodies(fixture: ChaosFixture): unknown[] {
  const bodies: unknown[] = [];
  const handle = fixture.cloudrop.handler;
  vi.spyOn(fixture.cloudrop, "handler").mockImplementation(async (request) => {
    const response = await handle(request);
    if (!response.ok) bodies.push(await response.clone().json());
    return response;
  });
  return bodies;
}

/** What the server logged, without the stack: the message and the storage error's classification. */
const loggedErrors = () =>
  chaos.logger.errors.map(({ message, error }) => {
    const { code, retryable, status, storageCode } = error as CloudropError;
    return { message, code, retryable, status, storageCode };
  });

test("a CompleteMultipartUpload the storage answers 503 reaches the client as a retryable RATE_LIMITED, and the retried /complete finishes the file", async () => {
  chaos.proxy.set([
    {
      match: { kind: "server", operation: "CompleteMultipartUpload" },
      fault: { kind: "answer", status: 503, body: SLOW_DOWN },
    },
  ]);
  const errorBodies = recordErrorBodies(chaos);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 503", "POST /complete 200"]);
  expect(errorBodies).toEqual([
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
  const errorBodies = recordErrorBodies(chaos);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 502", "POST /complete 200"]);
  expect(errorBodies).toEqual([STORAGE_FAILED]);
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
  const errorBodies = recordErrorBodies(chaos);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 502", "POST /complete 200"]);
  expect(errorBodies).toEqual([STORAGE_FAILED]);
  expect(chaos.bucketRequests()).toEqual(["PUT object 200", "HeadObject reset", "HeadObject 200"]);
  expect(loggedErrors()).toEqual([UNREACHABLE_LOGGED]);
});
