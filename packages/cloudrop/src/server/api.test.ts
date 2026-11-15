import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError, fail, ok } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { PUBLIC_URL, serverFixture } from "../testing/server-fixture.ts";
import { allowAnyone, route } from "./route.ts";

const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:34:56Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("api.getUrl", () => {
  it("returns the plain public URL, percent-encoded, when the storage has one", async () => {
    const { cloudrop } = serverFixture({ files }, { publicUrl: true });
    expect(await cloudrop.api.getUrl("team files/a+b.png")).toEqual({
      data: { url: `${PUBLIC_URL}/team%20files/a%2Bb.png`, expiresAt: null },
      error: null,
    });
  });

  it("signs a private URL at the start of its window, valid for two windows", async () => {
    const fixture = serverFixture({ files });
    await fixture.storage.put("docs/a.txt", "hello");
    const { data } = await fixture.cloudrop.api.getUrl("docs/a.txt", { expiresIn: 3600 });
    const url = new URL(data?.url ?? "");
    expect({
      date: url.searchParams.get("X-Amz-Date"),
      expires: url.searchParams.get("X-Amz-Expires"),
      expiresAt: data?.expiresAt,
    }).toEqual({ date: "20261115T120000Z", expires: "7200", expiresAt: new Date("2026-11-15T14:00:00Z") });
    expect(await (await fixture.fake.fetch(url)).text()).toBe("hello");
  });

  it("gives everyone in one window the same URL and a new one in the next", async () => {
    const { cloudrop } = serverFixture({ files });
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const first = await cloudrop.api.getUrl("a.txt");
    vi.setSystemTime(new Date("2026-11-15T12:59:59Z"));
    const sameWindow = await cloudrop.api.getUrl("a.txt");
    vi.setSystemTime(new Date("2026-11-15T13:00:00Z"));
    const nextWindow = await cloudrop.api.getUrl("a.txt");
    expect(sameWindow.data?.url).toBe(first.data?.url);
    expect(nextWindow.data?.url).not.toBe(first.data?.url);
  });

  it("signs a URL with the download name even on a public bucket, which cannot set it", async () => {
    const fixture = serverFixture({ files }, { publicUrl: true });
    await fixture.storage.put("r/1.pdf", "pdf");
    const { data } = await fixture.cloudrop.api.getUrl("r/1.pdf", { download: "Raport roczny.pdf" });
    const response = await fixture.fake.fetch(data?.url ?? "");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Raport roczny.pdf\"; filename*=UTF-8''Raport%20roczny.pdf",
    );
  });

  it.for<{ name: string; options: Record<string, unknown>; message: string }>([
    {
      name: "an expiry of 0",
      options: { expiresIn: 0 },
      message: "expiresIn must be a whole number of seconds from 1 to 302400.",
    },
    // Two windows of 302,401 s pass R2's 7-day presign limit.
    {
      name: "an expiry of 302,401 s",
      options: { expiresIn: 302_401 },
      message: "expiresIn must be a whole number of seconds from 1 to 302400.",
    },
    {
      name: "a fractional expiry",
      options: { expiresIn: 1.5 },
      message: "expiresIn must be a whole number of seconds from 1 to 302400.",
    },
    {
      name: "an empty download name",
      options: { download: "" },
      message: 'download must be a file name, such as "report.pdf".',
    },
    // A lone surrogate cannot be percent-encoded for filename*: encodeURIComponent would throw a URIError.
    {
      name: "a download name with a lone surrogate",
      options: { download: "\uD800.pdf" },
      message: 'download must be a file name, such as "report.pdf".',
    },
  ])("refuses $name", async ({ options, message }) => {
    const { cloudrop } = serverFixture({ files });
    expect((await cloudrop.api.getUrl("a.txt", options)).error).toMatchObject({ code: "INVALID_INPUT", message });
  });

  // getUrl(key, 3600) from plain JavaScript would otherwise hand out the public URL as if no options were given.
  it("refuses options that are not an object, even on a public bucket", async () => {
    const { cloudrop } = serverFixture({ files }, { publicUrl: true });
    expect((await cloudrop.api.getUrl("a.txt", 3600 as never)).error).toMatchObject({
      code: "INVALID_INPUT",
      message: "getUrl options must be an object, such as { expiresIn: 3600 }.",
    });
  });

  it("accepts the longest window, 302,400 s", async () => {
    const { cloudrop } = serverFixture({ files });
    expect((await cloudrop.api.getUrl("a.txt", { expiresIn: 302_400 })).error).toBeNull();
  });
});

describe("api.deletePrefix", () => {
  it("deletes every page under the prefix, proves it empty, and leaves a neighbouring prefix alone", async () => {
    const fixture = serverFixture({ files });
    // 1,001 keys: one more than a list page, so the second page must be fetched.
    const keys = Array.from({ length: 1001 }, (_, index) => `users/42/${index}.txt`);
    await Promise.all([...keys, "users/420/keep.txt"].map((key) => fixture.storage.put(key, "x")));
    expect(await fixture.cloudrop.api.deletePrefix("users/42/")).toEqual({
      data: { deleted: 1001, verifiedAt: new Date("2026-11-15T12:34:56Z") },
      error: null,
    });
    expect((await fixture.storage.list("users/")).data?.items.map((item) => item.key)).toEqual(["users/420/keep.txt"]);
  });

  it.for<{ name: string; prefix: unknown }>([
    { name: "an empty prefix, which is the whole bucket", prefix: "" },
    // Without the slash it would also match "users/420/".
    { name: "a prefix without a trailing slash", prefix: "users/42" },
    { name: "a lone slash", prefix: "/" },
    { name: "a number", prefix: 42 },
  ])("refuses $name without listing anything", async ({ prefix }) => {
    const fixture = serverFixture({ files });
    expect((await fixture.cloudrop.api.deletePrefix(prefix as string)).error).toMatchObject({
      code: "INVALID_INPUT",
      message: 'deletePrefix takes a folder prefix ending in "/", such as "users/42/".',
    });
    expect(fixture.storageCalls).toEqual([]);
  });

  function withStorage(changes: Partial<StorageDriver>) {
    const base = serverFixture({ files });
    const storage = { ...base.storage, ...changes };
    return { fixture: serverFixture({ files }, { storage }), base };
  }

  it("deletes nothing when the listing returns a key outside the prefix", async () => {
    const deleteMany = vi.fn<StorageDriver["deleteMany"]>();
    const { fixture } = withStorage({
      list: async () =>
        ok({ items: [{ key: "users/7/private.txt", size: 1, etag: "e", uploadedAt: new Date() }], nextCursor: null }),
      deleteMany,
    });
    expect((await fixture.cloudrop.api.deletePrefix("users/42/")).error?.message).toBe(
      "The storage listed keys outside the prefix, so nothing more was deleted.",
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("fails instead of looping when deleted keys are listed again", async () => {
    const { fixture } = withStorage({
      list: async () =>
        ok({ items: [{ key: "users/42/ghost.txt", size: 1, etag: "e", uploadedAt: new Date() }], nextCursor: null }),
      deleteMany: async (keys) => ok({ deleted: [...keys], failed: [] }),
    });
    expect((await fixture.cloudrop.api.deletePrefix("users/42/")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "Some keys were still listed after they were deleted. Retry deletePrefix.",
    });
  });

  it("stops after 10,000 pages when keys keep appearing", async () => {
    let page = 0;
    const { fixture } = withStorage({
      list: async () =>
        ok({
          items: [{ key: `users/42/${page++}.txt`, size: 1, etag: "e", uploadedAt: new Date() }],
          nextCursor: null,
        }),
      deleteMany: async (keys) => ok({ deleted: [...keys], failed: [] }),
    });
    expect((await fixture.cloudrop.api.deletePrefix("users/42/")).error?.message).toBe(
      "Objects kept appearing under users/42/ after 10000 pages were deleted. Stop writing there, then retry.",
    );
    expect(page).toBe(10_000);
  });

  it("reports keys it could not delete, with the first one's reason", async () => {
    const denied = new CloudropError("STORAGE_DENIED", "Access denied.");
    const { fixture } = withStorage({
      list: async () =>
        ok({ items: [{ key: "users/42/a.txt", size: 1, etag: "e", uploadedAt: new Date() }], nextCursor: null }),
      deleteMany: async () => ok({ deleted: [], failed: [{ key: "users/42/a.txt", error: denied }] }),
    });
    expect((await fixture.cloudrop.api.deletePrefix("users/42/")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: false,
      message: "Could not delete 1 of 1 keys, such as users/42/a.txt: Access denied.",
    });
  });

  it("passes a failed listing through", async () => {
    const down = new CloudropError("STORAGE_UNREACHABLE", "Could not reach the storage service.", { retryable: true });
    const { fixture } = withStorage({ list: async () => fail(down) });
    expect((await fixture.cloudrop.api.deletePrefix("users/42/")).error).toBe(down);
  });
});

describe("api.checkBucket", () => {
  const uploadRule = (expose: string) =>
    `<CORSRule><AllowedOrigin>https://app.example.com</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>content-disposition</AllowedHeader><AllowedHeader>if-none-match</AllowedHeader><AllowedHeader>x-amz-meta-*</AllowedHeader>${expose}</CORSRule>`;
  const abortRule =
    "<Rule><ID>abort</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>";

  it("reports a bucket that is ready for browser uploads", async () => {
    const fixture = serverFixture(
      { files },
      {
        trustedOrigins: ["https://app.example.com"],
        bucketConfig: {
          cors: `<CORSConfiguration>${uploadRule("<ExposeHeader>ETag</ExposeHeader>")}</CORSConfiguration>`,
          lifecycle: `<LifecycleConfiguration>${abortRule}</LifecycleConfiguration>`,
        },
      },
    );
    expect((await fixture.cloudrop.api.checkBucket()).data).toEqual({
      cors: { status: "ok", message: "Browsers on https://app.example.com can upload and read ETag." },
      lifecycle: { status: "ok", message: "Incomplete multipart uploads are aborted after 7 days." },
      publicAccess: { status: "ok", message: "No private route stores files on a public bucket." },
    });
  });

  it("finds a rule that does not expose ETag, a missing abort rule and a private route on a public bucket", async () => {
    const privateFiles = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone, visibility: "private" });
    const fixture = serverFixture(
      { privateFiles },
      {
        publicUrl: true,
        bucketConfig: {
          cors: `<CORSConfiguration>${uploadRule("")}</CORSConfiguration>`,
          lifecycle: "<LifecycleConfiguration></LifecycleConfiguration>",
        },
      },
    );
    expect((await fixture.cloudrop.api.checkBucket({ origins: ["https://app.example.com"] })).data).toEqual({
      cors: {
        status: "problem",
        message:
          "The bucket's CORS rules do not let https://app.example.com upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag.",
      },
      lifecycle: {
        status: "problem",
        message:
          "No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored. Add one (R2 creates a 7-day rule by default).",
      },
      publicAccess: {
        status: "problem",
        message:
          "Private routes (privateFiles) store files on a bucket with a public URL: anyone who learns a key can read the file.",
      },
    });
  });

  it("reports unknown, never missing, when the credentials may not read the settings", async () => {
    const { cloudrop } = serverFixture({ files });
    const report = await cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });
    expect([report.data?.cors.status, report.data?.lifecycle.status]).toEqual(["unknown", "unknown"]);
  });

  it("asks for origins when it has none to check", async () => {
    const { cloudrop } = serverFixture({ files }, { bucketConfig: {} });
    expect((await cloudrop.api.checkBucket()).data?.cors).toEqual({
      status: "unknown",
      message: 'Name the origins your pages upload from: api.checkBucket({ origins: ["https://app.example.com"] }).',
    });
  });

  // Origins are echoed in the report, so only exact origins may reach it: no path, header or credential text.
  it.for<{ name: string; options: unknown }>([
    { name: "options that are not an object", options: "https://app.example.com" },
    { name: "origins that are not a list", options: { origins: "https://app.example.com" } },
    { name: "an origin that is not text", options: { origins: [42] } },
    { name: "an origin with a path", options: { origins: ["https://app.example.com/upload"] } },
    { name: "an origin with a line break", options: { origins: ["https://app.example.com\r\nx-forged: 1"] } },
    { name: "an origin with credentials", options: { origins: ["https://user:secret@app.example.com"] } },
    { name: "a wildcard", options: { origins: ["*"] } },
  ])("refuses $name", async ({ options }) => {
    const { cloudrop } = serverFixture({ files }, { bucketConfig: {} });
    expect(await cloudrop.api.checkBucket(options as never)).toMatchObject({
      data: null,
      error: {
        code: "INVALID_INPUT",
        message:
          'checkBucket takes { origins } with exact origins such as "https://app.example.com": scheme and host, no path or trailing slash.',
      },
    });
  });
});

describe("development start-up warnings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("checks the bucket once, on the first request in development, and logs each problem", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fixture = serverFixture(
      { files },
      {
        trustedOrigins: ["https://app.example.com"],
        bucketConfig: { cors: "<CORSConfiguration></CORSConfiguration>" },
      },
    );
    // A check starts both reads before its first await, so a second check would have called them by the time the
    // second request is answered: counting the calls needs no wait.
    const corsReads = vi.spyOn(fixture.storage, "getBucketCors");
    const lifecycleReads = vi.spyOn(fixture.storage, "getBucketLifecycle");
    await fixture.post("upload", { route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });
    await fixture.post("upload", { route: "files", files: [{ name: "b.txt", size: 1, type: "text/plain" }] });
    expect([corsReads.mock.calls.length, lifecycleReads.mock.calls.length]).toEqual([1, 1]);
    await vi.waitFor(() =>
      expect(fixture.logger.warnings).toEqual([
        "cloudrop: The bucket's CORS rules do not let https://app.example.com upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag.",
        "cloudrop: No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored. Add one (R2 creates a 7-day rule by default).",
      ]),
    );
  });

  it("checks the origin of the first request's page when there are no trustedOrigins", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fixture = serverFixture(
      { files },
      {
        bucketConfig: {
          cors: "<CORSConfiguration></CORSConfiguration>",
          lifecycle:
            "<LifecycleConfiguration><Rule><ID>abort</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
        },
      },
    );
    await fixture.post("upload", { route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });
    await vi.waitFor(() =>
      expect(fixture.logger.warnings).toEqual([
        "cloudrop: The bucket's CORS rules do not let https://app.example.com upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag.",
      ]),
    );
  });

  // An unhandled rejection would stop a Node development server.
  it("logs a check that throws instead of leaving its rejection unhandled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const base = serverFixture({ files });
    const broken = new Error("custom driver bug");
    const storage = {
      ...base.storage,
      getBucketCors: () => {
        throw broken;
      },
    };
    const fixture = serverFixture({ files }, { storage });
    const response = await fixture.post("upload", {
      route: "files",
      files: [{ name: "a.txt", size: 1, type: "text/plain" }],
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(fixture.logger.errors).toEqual([
        { message: "cloudrop: the development bucket check failed.", error: broken },
      ]),
    );
  });

  it("does not check the bucket outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fixture = serverFixture({ files });
    await fixture.post("upload", { route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });
    expect(fixture.storageCalls).toEqual([]);
  });
});
