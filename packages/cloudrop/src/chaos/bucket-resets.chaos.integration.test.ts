// Chaos rows 1-3 (design spec §4): a presigned part PUT whose connection the proxy resets mid-body, once and on every
// attempt, through upload() and through start() then retry(). The proxy log is what reached the bucket; the app calls
// are what reached the server. Run with `bun run test:chaos`.
import { expect, test } from "vitest";
import { MiB } from "../rules.ts";
import { chaosFile, MULTIPART_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";
import type { ChaosRule } from "../testing/chaos-proxy.ts";

const chaos = useChaosFixture();

/** Every attempt of part 2 loses its connection after 1 MiB of its 8 MiB. */
const RESET_PART_2: ChaosRule = {
  match: { operation: "UploadPart", part: 2, nth: "every" },
  fault: { kind: "reset", afterBytes: MiB },
};

test("row 1: a part reset after 1 MiB is renewed through /sign, sent again, and the file is stored whole", async () => {
  const file = chaosFile(MULTIPART_FILE_SIZE);
  chaos.proxy.set([{ ...RESET_PART_2, match: { operation: "UploadPart", part: 2 } }]);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  // An opaque failure renews that part's URL once, then retries (decisions S10, S11).
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /complete 200"]);
  const requests = chaos.bucketRequests();
  // The three parts start at once, so their order is the network's; the second part 2 starts after the reset.
  expect(requests.slice(1, 4).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 reset", "PUT part 3 200"]);
  expect([requests[0], ...requests.slice(4)]).toEqual([
    "CreateMultipartUpload 200",
    "PUT part 2 200",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
});

test("row 2: a part reset on all 6 attempts fails upload() with a retryable NETWORK_ERROR and its /abort leaves nothing", async () => {
  chaos.proxy.set([RESET_PART_2]);

  const { data, error } = await chaos.client().upload("files", chaosFile(MULTIPART_FILE_SIZE));

  expect(data).toBeNull();
  expect([error?.code, error?.retryable]).toEqual(["NETWORK_ERROR", true]);
  // upload() answers before its /abort lands (decision S15); its answer comes after its last storage call.
  await chaos.waitForApp("POST /abort 200");
  // One renewal for the part, after its first failure only (S11).
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /abort 200"]);
  const requests = chaos.bucketRequests();
  expect(requests[0]).toBe("CreateMultipartUpload 200");
  // Parts 1 and 3 were already sent and finish (M3-U18); part 2 has its 6 attempts and not one more (S9).
  // M3-U18's "no new part starts" needs more than 4 parts; client/parts.test.ts:181 proves it.
  expect(requests.slice(1, -2).toSorted()).toEqual([
    "PUT part 1 200",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 3 200",
  ]);
  expect(requests.slice(-2)).toEqual(["AbortMultipartUpload 204", "HeadObject 404"]);
  await chaos.expectNoUploadsLeft();
  expect(await chaos.objectsLeft()).toEqual([]);
});

test("row 3: after the same failure through start(), retry() keeps the ticket and sends only part 2 and /complete", async () => {
  const file = chaosFile(MULTIPART_FILE_SIZE);
  chaos.proxy.set([RESET_PART_2]);
  const job = chaos.client().start("files", [file]);

  const failed = await job.done;

  expect([failed.error?.code, failed.error?.retryable]).toEqual(["NETWORK_ERROR", true]);
  // start() keeps the ticket and the parts that landed for retry() (spec §4.7): no /abort, the upload stays open.
  const open = await chaos.uploadsLeft();
  expect(open.length).toBe(1);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200"]);
  const requests = chaos.bucketRequests();
  expect(requests[0]).toBe("CreateMultipartUpload 200");
  // The same 6 attempts of part 2 as row 2, and parts 1 and 3 once each.
  expect(requests.slice(1).toSorted()).toEqual([
    "PUT part 1 200",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 2 reset",
    "PUT part 3 200",
  ]);

  chaos.proxy.set([]);
  chaos.proxy.clearLog();
  const retried = await job.files[0]?.retry();

  // NETWORK_ERROR is not in M3-U31's list, so the same ticket goes on, under the same key (M3-U30): no /upload, and
  // part 2's URL from the ticket is still fresh, so no /sign either.
  expect(retried).toMatchObject({ status: "done", result: { file: { key: open[0]?.key } } });
  expect(chaos.appRequests().slice(2)).toEqual(["POST /complete 200"]);
  expect(chaos.bucketRequests()).toEqual(["PUT part 2 200", "ListParts 200", "CompleteMultipartUpload 200"]);
  await chaos.expectStored(open[0]?.key ?? "", file);
  await chaos.expectNoUploadsLeft();
});
