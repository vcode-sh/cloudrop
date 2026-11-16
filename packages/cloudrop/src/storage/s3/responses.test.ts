import { describe, expect, it } from "vitest";
import type { Result } from "../../errors.ts";
import type { FetchLike, StorageDriver } from "../driver.ts";
import { copyStub, driverWith, lastModified, stubbed } from "./driver-fixture.ts";

describe("createS3Driver", () => {
  it("reports a HEAD answer without a size as a retryable storage error, never as an empty object", async () => {
    const sizeless = stubbed(async () => new Response(null, { headers: { etag: '"e"' } }));
    expect((await driverWith(sizeless).head("a.txt")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no content length. Retry the request.",
    });
  });

  it.each([
    ["without an ETag", {}],
    ["with a quoted empty ETag", { etag: '""' }],
  ])("reports a HEAD answer %s as a retryable storage error", async (_name, etag) => {
    // copy() sends the ETag as x-amz-copy-source-if-match; an empty one would not guard the copy at all.
    const etagless = stubbed(async () => new Response(null, { headers: { "content-length": "1", ...etag } }));
    expect((await driverWith(etagless).head("a.txt")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no ETag. Retry the request.",
    });
  });

  const partsPage = (part: string) =>
    `<ListPartsResult><IsTruncated>false</IsTruncated><Part>${part}</Part></ListPartsResult>`;
  const objectsPage = (contents: string) =>
    `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>${contents}</Contents></ListBucketResult>`;
  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, () => Response, string]>([
    // /complete compares each listed part's size with the plan; a NaN size would read as a part to upload again.
    [
      "a part without a size",
      (driver) => driver.listParts("a.bin", "u"),
      () => new Response(partsPage('<PartNumber>1</PartNumber><ETag>"a"</ETag>')),
      "valid part size",
    ],
    [
      "a part number of 0",
      (driver) => driver.listParts("a.bin", "u"),
      () => new Response(partsPage('<PartNumber>0</PartNumber><ETag>"a"</ETag><Size>5</Size>')),
      "valid part number",
    ],
    [
      "a part number over the part limit",
      (driver) => driver.listParts("a.bin", "u"),
      () => new Response(partsPage('<PartNumber>10001</PartNumber><ETag>"a"</ETag><Size>5</Size>')),
      "valid part number",
    ],
    [
      "a part with an empty ETag",
      (driver) => driver.listParts("a.bin", "u"),
      () => new Response(partsPage('<PartNumber>1</PartNumber><ETag>""</ETag><Size>5</Size>')),
      "part ETag",
    ],
    [
      "a listed object without a key",
      (driver) => driver.list(""),
      () =>
        new Response(
          objectsPage('<Size>1</Size><ETag>"e"</ETag><LastModified>2026-11-15T12:00:00.000Z</LastModified>'),
        ),
      "object key",
    ],
    [
      "a listed object with a negative size",
      (driver) => driver.list(""),
      () =>
        new Response(
          objectsPage(
            '<Key>a</Key><Size>-1</Size><ETag>"e"</ETag><LastModified>2026-11-15T12:00:00.000Z</LastModified>',
          ),
        ),
      "valid object size",
    ],
    [
      "a listed object with an unreadable date",
      (driver) => driver.list(""),
      () =>
        new Response(objectsPage('<Key>a</Key><Size>1</Size><ETag>"e"</ETag><LastModified>yesterday</LastModified>')),
      "valid last-modified date",
    ],
    [
      "a HEAD answer with a size that is not a number",
      (driver) => driver.head("a.txt"),
      () => new Response(null, { headers: { "content-length": "abc", etag: '"e"', "last-modified": lastModified } }),
      "valid content length",
    ],
    // Read as the epoch until now: a valid Date, and a false one.
    [
      "a HEAD answer without a last-modified date",
      (driver) => driver.head("a.txt"),
      () => new Response(null, { headers: { "content-length": "1", etag: '"e"' } }),
      "valid last-modified date",
    ],
  ])("reports %s as a retryable storage error", async (_name, call, respond, missing) => {
    expect((await call(driverWith(stubbed(async () => respond())))).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: `The storage service's response had no ${missing}. Retry the request.`,
    });
  });

  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, FetchLike]>([
    [
      "completion",
      (driver) => driver.completeMultipart("a.txt", "u", [{ partNumber: 1, etag: "e" }]),
      stubbed(async () => new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>")),
    ],
    [
      "single copy",
      (driver) => driver.copy("a.txt", "b.txt"),
      copyStub(
        5,
        stubbed(async () => new Response("<CopyObjectResult></CopyObjectResult>")),
      ),
    ],
  ])("reports a successful %s without an ETag as a retryable storage error", async (_name, call, fetch) => {
    expect((await call(driverWith(fetch))).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no ETag. Retry the request.",
    });
  });

  it("reports a truncated object list without a continuation token instead of ending early", async () => {
    const truncated = stubbed(
      async () => new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
    );
    expect((await driverWith(truncated).list("")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no continuation token. Retry the request.",
    });
  });

  it("stops when a truncated part list does not advance its marker", async () => {
    const stuck = stubbed(
      async () =>
        new Response(
          "<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>0</NextPartNumberMarker></ListPartsResult>",
        ),
    );
    expect((await driverWith(stuck).listParts("big.bin", "upload-1")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
    });
  });

  it("reports a create response without an upload ID as a retryable storage error", async () => {
    const empty = stubbed(async () => new Response("<InitiateMultipartUploadResult></InitiateMultipartUploadResult>"));
    expect((await driverWith(empty).createMultipart("a.txt", {})).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
    });
  });
});
