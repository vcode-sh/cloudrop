import { describe, expect, it } from "vitest";
import { MiB, R2_RULES } from "../../rules.ts";
import { offsetBytes } from "../../testing/storage-contract.ts";
import type { FetchLike } from "../driver.ts";
import { createS3Driver } from "../s3-driver.ts";
import { sha256Hex, signRequest } from "../sigv4.ts";
import {
  copyStub,
  credentials,
  driverWith,
  endpoint,
  now,
  setup,
  signedAt,
  stubbed,
  timesOut,
} from "./driver-fixture.ts";

/** Stores an object the way another tool would, with headers the driver itself refuses to send. */
async function putWithForeignTool(
  fetch: FetchLike,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
) {
  const url = new URL(`${endpoint}/test/${key}`);
  const payloadHash = await sha256Hex(body);
  const signed = await signRequest({
    method: "PUT",
    url,
    headers,
    credentials,
    region: "auto",
    date: signedAt,
    payloadHash,
  });
  expect((await fetch(url, { method: "PUT", headers: signed, body })).status).toBe(200);
}

describe("createS3Driver", () => {
  it("keeps stored headers the driver would not accept as input when it copies in parts", async () => {
    const { fake, driver } = setup();
    // An underscore in a metadata name fails cloudrop's input rules, but the copy must keep what is stored.
    await putWithForeignTool(fake.fetch, "source.bin", offsetBytes(12 * MiB), {
      "content-type": "application/x-test",
      "x-amz-meta-legacy_id": "s1",
    });
    // Same bucket, lower single-PUT limit, so a 12 MiB copy takes the multipart path without a 5 GiB fixture.
    const small = createS3Driver({
      endpoint,
      region: "auto",
      bucket: "test",
      credentials,
      rules: { ...R2_RULES, maxSinglePutSize: 6 * MiB },
      fetch: fake.fetch,
      now,
    });
    expect((await small.copy("source.bin", "copy.bin")).error).toBeNull();
    expect((await driver.head("copy.bin")).data).toMatchObject({
      type: "application/x-test",
      metadata: { legacy_id: "s1" },
    });
  });

  it.each([
    ["a single", 5],
    ["a multipart", R2_RULES.maxSinglePutSize + 1],
  ])("gives %s server-side copy five minutes per request", async (_name, size) => {
    const result = await driverWith(copyStub(size, timesOut)).copy("a.txt", "b.txt");
    expect(result.error?.message).toBe("The storage service did not answer within 300 seconds. Retry the request.");
  });

  it("aborts a multipart copy whose part result has no ETag", async () => {
    const aborted: string[] = [];
    const noEtag = stubbed(async () => new Response("<CopyPartResult></CopyPartResult>"));
    const result = await driverWith(copyStub(R2_RULES.maxSinglePutSize + 1, noEtag, aborted)).copy("a.txt", "b.txt");
    expect(result.error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no ETag. Retry the request.",
    });
    expect(aborted).toEqual(["u1"]);
  });
});
