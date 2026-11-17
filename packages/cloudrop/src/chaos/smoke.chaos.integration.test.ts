// The chaos lane's baseline: with no fault, an upload through the proxy behaves as without it. Every faulted row
// reads its sequence against this one. Run with `bun run test:chaos`.
import { expect, test } from "vitest";
import { chaosFile, MULTIPART_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

test("a multipart upload with no fault is stored whole, leaves no upload open, and sends each request once", async () => {
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  const key = data?.file.key ?? "";
  expect(key.startsWith(chaos.prefix)).toBe(true);
  await chaos.expectStored(key, file);
  await chaos.expectNoUploadsLeft();
  // Read after the oracle ran: its reads go to RustFS directly, so the log holds the upload's requests only.
  const requests = chaos.bucketRequests();
  expect([requests[0], ...requests.slice(4)]).toEqual([
    "CreateMultipartUpload 200",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  // The three parts run at once, so their start order is the network's.
  expect(requests.slice(1, 4).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 200", "PUT part 3 200"]);
});
