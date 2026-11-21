// An endpoint that is not an S3 API: the port of a console, the host of a single-page app or a captive portal answers
// every request with 200 and a page. Real servers and the real fetch, so redirects are followed (or not) as in an app.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Result } from "../../errors.ts";
import { R2_RULES } from "../../rules.ts";
import { credentials, lastModified } from "../../testing/driver-fixture.ts";
import type { FetchLike } from "../driver.ts";
import { createS3DriverWithWrites, type S3Driver } from "../s3-driver.ts";

const page = '<!doctype html><html><body><div id="app"></div></body></html>';
// As Express and most app hosts send a page: with its length, a date and a weak ETag, to every method.
const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "content-length": String(page.length),
  "last-modified": lastModified,
  etag: 'W/"3e-19a8b7c6d5e"',
};

let pageHost: Server;
let redirector: Server;
const pageRequests: string[] = [];

const listening = (server: Server): Promise<void> => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const closed = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
const urlOf = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function driverAt(server: Server, fetch?: FetchLike): S3Driver {
  return createS3DriverWithWrites({
    endpoint: urlOf(server),
    region: "auto",
    bucket: "test",
    credentials,
    rules: R2_RULES,
    fetch,
  });
}

beforeAll(async () => {
  pageHost = createServer((request, response) => {
    pageRequests.push(`${request.method} ${request.url}`);
    // Drained, so a PUT's body never holds the connection.
    request.resume().on("end", () => response.writeHead(200, pageHeaders).end(request.method === "HEAD" ? "" : page));
  });
  redirector = createServer((request, response) => {
    request.resume().on("end", () => response.writeHead(302, { location: `${urlOf(pageHost)}${request.url}` }).end());
  });
  await Promise.all([listening(pageHost), listening(redirector)]);
});

afterAll(() => Promise.all([closed(pageHost), closed(redirector)]));

const incomplete = (missing: string) => `The storage service's response had no ${missing}. Retry the request.`;
const tooLarge = "The storage endpoint sent more data than an S3 answer holds. Check the endpoint setting.";
const corsRule = { allowedOrigins: ["*"], allowedMethods: ["GET"], allowedHeaders: [], exposeHeaders: [] };
const lifecycleRule = { id: "abort", enabled: true, prefix: "", abortIncompleteMultipartUploadDays: 1 };

type Call = (driver: S3Driver) => Promise<Result<unknown>>;

const calls: [string, Call, string][] = [
  ["list", (driver) => driver.list("users/42/"), incomplete("object listing")],
  ["listParts", (driver) => driver.listParts("a.bin", "upload-1"), incomplete("part listing")],
  ["createMultipart", (driver) => driver.createMultipart("a.bin", {}), incomplete("upload ID")],
  [
    "completeMultipart",
    (driver) => driver.completeMultipart("a.bin", "upload-1", [{ partNumber: 1, etag: "e" }]),
    incomplete("ETag"),
  ],
  ["head", (driver) => driver.head("a.txt"), incomplete("ETag")],
  ["copy", (driver) => driver.copy("a.txt", "b.txt"), incomplete("ETag")],
  [
    "getRange",
    (driver) => driver.getRange("a.txt", 0, 4095),
    "The storage service ignored the byte range. Check that the endpoint supports ranged GET.",
  ],
  ["put", (driver) => driver.put("a.txt", "hello"), tooLarge],
  ["delete", (driver) => driver.delete("a.txt"), tooLarge],
  ["abortMultipart", (driver) => driver.abortMultipart("a.bin", "upload-1"), tooLarge],
  ["getBucketCors", (driver) => driver.getBucketCors(), incomplete("CORS configuration")],
  ["getBucketLifecycle", (driver) => driver.getBucketLifecycle(), incomplete("lifecycle configuration")],
  ["putBucketCors", (driver) => driver.putBucketCors([corsRule]), tooLarge],
  ["putBucketLifecycle", (driver) => driver.putBucketLifecycle([lifecycleRule]), tooLarge],
];

describe("an endpoint that answers every request with a web page", () => {
  it.each(calls)("%s answers a storage error, never a result", async (_name, call, message) => {
    const result = await call(driverAt(pageHost));
    expect({ data: result.data, error: result.error?.message }).toEqual({ data: null, error: message });
    expect(result.error?.code).toBe("STORAGE_ERROR");
  });

  it("deleteMany reports every key as failed, none as deleted", async () => {
    const result = await driverAt(pageHost).deleteMany(["a.txt", "b.txt"]);
    expect(result.data?.deleted).toEqual([]);
    // By key: the keys are deleted at once, so the list's order is the order the answers came in.
    expect(Object.fromEntries(result.data?.failed.map(({ key, error }) => [key, error.message]) ?? [])).toEqual({
      "a.txt": tooLarge,
      "b.txt": tooLarge,
    });
  });
});

describe("an endpoint that redirects to another host", () => {
  const redirected =
    "The storage endpoint redirected the request, or the bucket is in another region. Check the endpoint and region settings.";

  it.each(calls)("%s reports the redirect and sends nothing to the other host", async (_name, call) => {
    pageRequests.length = 0;
    const result = await call(driverAt(redirector));
    expect({ data: result.data, error: result.error?.message }).toEqual({ data: null, error: redirected });
    expect(pageRequests).toEqual([]);
  });

  it("reports the redirect when a custom fetch followed it anyway", async () => {
    const following: FetchLike = (input, init) => fetch(input, { ...init, redirect: "follow" });
    const result = await driverAt(redirector, following).list("users/42/");
    expect(result.error).toMatchObject({ code: "STORAGE_ERROR", retryable: false, message: redirected });
  });
});
