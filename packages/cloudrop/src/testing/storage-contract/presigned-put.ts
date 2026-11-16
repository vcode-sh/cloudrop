// Presigned PUT rules: what a signed URL accepts, refuses and leaves stored.

import { expect, it } from "vitest";
import { type ContractSuite, offsetBytes, outcome } from "./suite.ts";

export function presignedPutCases(suite: ContractSuite): void {
  const { key, skipWithout, signedPut } = suite;

  it("accepts a presigned PUT whose body matches the signed size and headers", async () => {
    const { driver } = suite;
    const k = key("presigned.bin");
    const send = await signedPut(k, {
      size: 1024,
      expiresIn: 300,
      type: "application/octet-stream",
      metadata: { "cloudrop-id": "f2" },
      ifNoneMatch: true,
    });
    expect((await send(offsetBytes(1024))).status).toBe(200);
    expect((await driver.head(k)).data).toMatchObject({ size: 1024, metadata: { "cloudrop-id": "f2" } });
  });

  it("stores an empty file through a presigned PUT", async () => {
    const { driver } = suite;
    const k = key("empty.txt");
    const send = await signedPut(k, { size: 0, expiresIn: 300, type: "text/plain", ifNoneMatch: true });
    expect((await send(new Uint8Array())).status).toBe(200);
    expect((await driver.head(k)).data).toMatchObject({ size: 0, type: "text/plain" });
  });

  it("rejects presigned PUTs with a different size or content type", async (ctx) => {
    const { driver } = suite;
    skipWithout(ctx, "signedHeaders");
    const k = key("wrong.bin");
    const send = await signedPut(k, { size: 1024, expiresIn: 300, type: "image/png" });
    const rejected = { status: 403, code: "SignatureDoesNotMatch" };
    expect(await outcome(await send(offsetBytes(1023)))).toEqual(rejected);
    expect(await outcome(await send(offsetBytes(1025)))).toEqual(rejected);
    expect(await outcome(await send(offsetBytes(1024), { "content-type": "text/html" }))).toEqual(rejected);
    expect((await driver.head(k)).data).toBeNull();
    expect((await send(offsetBytes(1024))).status).toBe(200);
  });

  it("answers a presigned PUT carrying an unsigned metadata header as recorded for the backend", async () => {
    const { driver, target } = suite;
    const k = key("unsigned-meta.bin");
    const send = await signedPut(k, { size: 16, expiresIn: 300, metadata: { "cloudrop-id": "f6" } });
    const response = await send(offsetBytes(16), { "x-amz-meta-injected": "yes" });
    const expected = {
      stored: { status: 200, code: "", metadata: { "cloudrop-id": "f6", injected: "yes" } },
      ignored: { status: 200, code: "", metadata: { "cloudrop-id": "f6" } },
      // Real R2's answer, measured by the live lane on 2026-11-15: nothing is stored. RustFS answers AccessDenied
      // ("There were headers present in the request which were not signed"), as AWS S3 documents.
      rejected: { status: 403, code: target.unsignedMetaCode ?? "SignatureDoesNotMatch", metadata: undefined },
    }[target.unsignedMetaOnPresignedPut];
    expect({ ...(await outcome(response)), metadata: (await driver.head(k)).data?.metadata }).toEqual(expected);
  });

  it("refuses to overwrite through a create-only URL", async () => {
    const { driver } = suite;
    const k = key("create-only.bin");
    const send = await signedPut(k, { size: 16, expiresIn: 300, ifNoneMatch: true });
    expect((await send(offsetBytes(16))).status).toBe(200);
    expect(await outcome(await send(new Uint8Array(16)))).toEqual({ status: 412, code: "PreconditionFailed" });
    // The first body survives: the word at offset 4 holds 4.
    expect((await driver.getRange(k, 4, 7)).data).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x04]));
  });

  it("rejects an expired presigned URL", async () => {
    const { driver, target } = suite;
    const k = key("expired.bin");
    const send = await signedPut(k, { size: 16, expiresIn: 60 }, target.driverWith({ secondsAgo: 120 }));
    expect(await outcome(await send(offsetBytes(16)))).toEqual({
      status: 403,
      code: target.expiredUrlCode ?? "ExpiredRequest",
    });
    expect((await driver.head(k)).data).toBeNull();
  });
}
