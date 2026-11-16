import { describe, expect, it } from "vitest";
import type { FetchLike } from "../driver.ts";
import { driverWith } from "./driver-fixture.ts";

describe("createS3Driver", () => {
  it("follows ListParts pagination with the marker the storage returned", async () => {
    const pages = [
      '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1000</NextPartNumberMarker><Part><PartNumber>1000</PartNumber><ETag>"a"</ETag><Size>8388608</Size></Part></ListPartsResult>',
      '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1001</PartNumber><ETag>"b"</ETag><Size>5</Size></Part></ListPartsResult>',
    ];
    const markers: (string | null)[] = [];
    const fetch: FetchLike = async (input) => {
      markers.push(new URL(String(input)).searchParams.get("part-number-marker"));
      return new Response(pages[markers.length - 1], { status: 200 });
    };
    expect((await driverWith(fetch).listParts("big.bin", "upload-1")).data).toEqual([
      { partNumber: 1000, size: 8_388_608, etag: "a", checksumCrc32c: undefined },
      { partNumber: 1001, size: 5, etag: "b", checksumCrc32c: undefined },
    ]);
    expect(markers).toEqual(["0", "1000"]);
  });

  it("completes with the parts in ascending order and their ETags escaped and quoted once", async () => {
    let sent = "";
    const capture: FetchLike = async (_input, init) => {
      sent = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response('<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>');
    };
    const parts = [
      { partNumber: 2, etag: "b&" },
      // As a browser reads it from the part's ETag response header, quotes included.
      { partNumber: 1, etag: '"a<"' },
    ];
    expect((await driverWith(capture).completeMultipart("a", "u", parts)).data).toEqual({ etag: "x-2" });
    expect(sent).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"a&lt;"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"b&amp;"</ETag></Part></CompleteMultipartUpload>',
    );
  });
});
