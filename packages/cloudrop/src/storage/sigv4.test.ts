import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { EMPTY_SHA256, encodeKeyPath, encodeRfc3986, presignUrl, sha256Hex, signRequest } from "./sigv4.ts";

const AWS_EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");
const EXAMPLE_URL = "https://examplebucket.s3.amazonaws.com/test.txt";
const EXAMPLE_CREDENTIAL = "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ";

describe("presignUrl", () => {
  it("matches the AWS S3 query-string signing example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await presignUrl({
      method: "GET",
      url: new URL(EXAMPLE_URL),
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      expiresIn: 86_400,
    });
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("agrees with aws4fetch on signed headers, encoded keys and existing query parameters", async () => {
    const credentials = { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };
    const base =
      "https://account.r2.cloudflarestorage.com/bucket/a%20b/%C3%A9%2B(1)!'*.png?partNumber=3&uploadId=abc%2Fdef";
    const headers = { "content-length": "5242880", "content-type": "image/png", "if-none-match": "*" };
    const ours = await presignUrl({
      method: "PUT",
      url: new URL(base),
      headers,
      credentials,
      region: "auto",
      date: new Date("2026-11-15T12:00:00Z"),
      expiresIn: 900,
    });
    const client = new AwsClient({ ...credentials, service: "s3", region: "auto" });
    const theirs = await client.sign(`${base}&X-Amz-Expires=900`, {
      method: "PUT",
      headers,
      aws: { signQuery: true, allHeaders: true, datetime: "20261115T120000Z" },
    });
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(new URL(theirs.url).searchParams.get("X-Amz-Signature"));
  });

  it("keeps the caller's query parameters and adds the signing parameters", async () => {
    const url = await presignUrl({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt?partNumber=3"),
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      expiresIn: 60,
    });
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});

describe("signRequest", () => {
  it("matches the AWS S3 header signing GET Object example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html ("Example: GET Object")
    const headers = await signRequest({
      method: "GET",
      url: new URL(EXAMPLE_URL),
      headers: { range: "bytes=0-9" },
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      payloadHash: EMPTY_SHA256,
    });
    expect(headers.authorization).toBe(
      `${EXAMPLE_CREDENTIAL}SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ` +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("returns the input headers plus the content hash and date", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL(EXAMPLE_URL),
      headers: { range: "bytes=0-9" },
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      payloadHash: EMPTY_SHA256,
    });
    expect(headers).toMatchObject({
      range: "bytes=0-9",
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": "20130524T000000Z",
    });
  });

  it.each([
    {
      name: "GET Bucket (List Objects): sorted query parameters",
      url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      signature: "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    },
    {
      name: "GET Bucket Lifecycle: a parameter without a value",
      url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
      signature: "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    },
  ])("matches the AWS example $name", async ({ url, signature }) => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const headers = await signRequest({
      method: "GET",
      url: new URL(url),
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      payloadHash: EMPTY_SHA256,
    });
    expect(headers.authorization).toBe(
      `${EXAMPLE_CREDENTIAL}SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    );
  });

  it("matches the AWS S3 header signing PUT Object example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html ("Example: PUT Object")
    const body = new TextEncoder().encode("Welcome to Amazon S3.");
    const headers = await signRequest({
      method: "PUT",
      url: new URL(`https://examplebucket.s3.amazonaws.com/${encodeKeyPath("test$file.text")}`),
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      payloadHash: await sha256Hex(body),
    });
    expect(headers.authorization).toBe(
      `${EXAMPLE_CREDENTIAL}SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ` +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("agrees with aws4fetch when header values carry extra whitespace", async () => {
    const credentials = { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };
    const url = "https://account.r2.cloudflarestorage.com/bucket/a%20b.txt?uploads";
    const headers = { "content-type": "  text/plain;   charset=utf-8 ", "x-amz-meta-note": "a    b" };
    const ours = await signRequest({
      method: "POST",
      url: new URL(url),
      headers,
      credentials,
      region: "auto",
      date: new Date("2026-11-15T12:00:00Z"),
      payloadHash: EMPTY_SHA256,
    });
    const client = new AwsClient({ ...credentials, service: "s3", region: "auto" });
    const theirs = await client.sign(url, {
      method: "POST",
      headers: { ...headers, "x-amz-content-sha256": EMPTY_SHA256 },
      aws: { allHeaders: true, datetime: "20261115T120000Z" },
    });
    expect(ours.authorization).toBe(theirs.headers.get("authorization"));
  });
});

describe("signing key reuse", () => {
  it("never reuses a key across secrets, regions or days", async () => {
    const url = "https://account.r2.cloudflarestorage.com/bucket/key.txt";
    const variants = [
      { secretAccessKey: "secret-one", region: "auto", at: "2026-11-15T12:00:00Z" },
      { secretAccessKey: "secret-two", region: "auto", at: "2026-11-15T12:00:00Z" },
      { secretAccessKey: "secret-one", region: "eu", at: "2026-11-15T12:00:00Z" },
      { secretAccessKey: "secret-one", region: "auto", at: "2026-11-16T12:00:00Z" },
      { secretAccessKey: "secret-one", region: "auto", at: "2026-11-15T12:00:00Z" },
    ];
    for (const { secretAccessKey, region, at } of variants) {
      const credentials = { accessKeyId: "test-access-key", secretAccessKey };
      const ours = await presignUrl({
        method: "GET",
        url: new URL(url),
        credentials,
        region,
        date: new Date(at),
        expiresIn: 60,
      });
      const theirs = await new AwsClient({ ...credentials, service: "s3", region }).sign(`${url}?X-Amz-Expires=60`, {
        aws: { signQuery: true, datetime: at.replace(/[-:]/g, "") },
      });
      expect(ours.searchParams.get("X-Amz-Signature")).toBe(new URL(theirs.url).searchParams.get("X-Amz-Signature"));
    }
  });
});

describe("encodeKeyPath", () => {
  it("encodes every segment with RFC 3986 rules and keeps slashes", () => {
    expect(encodeKeyPath("a b/é+(1)!.png")).toBe("a%20b/%C3%A9%2B%281%29%21.png");
  });
});

describe("encodeRfc3986", () => {
  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(encodeRfc3986("!'()*")).toBe("%21%27%28%29%2A");
  });
});

describe("sha256Hex", () => {
  it("hashes the empty string to the published constant", async () => {
    expect(await sha256Hex("")).toBe(EMPTY_SHA256);
  });
});
