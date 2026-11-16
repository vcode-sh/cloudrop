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

/** A server whose storage is the fake with some methods replaced. */
function withStorage(changes: Partial<StorageDriver>) {
  return serverFixture({ files }, { storage: { ...serverFixture({ files }).storage, ...changes } });
}

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
    // null is a value, not an omission: plain JavaScript must not get the default window for it.
    {
      name: "an expiry of null",
      options: { expiresIn: null },
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
    const { storage } = serverFixture({ files });
    // Pages of two keys, so three keys need a second page. At R2's 1,000-key page that took 1,001 keys and ~2,000
    // signed requests to the fake, about 250 ms, for the same loop.
    const { cloudrop } = serverFixture(
      { files },
      { storage: { ...storage, list: (prefix, options) => storage.list(prefix, { ...options, limit: 2 }) } },
    );
    await Promise.all(
      ["users/42/a.txt", "users/42/b.txt", "users/42/c.txt", "users/420/keep.txt"].map((key) => storage.put(key, "x")),
    );
    expect(await cloudrop.api.deletePrefix("users/42/")).toEqual({
      data: { deleted: 3, verifiedAt: new Date("2026-11-15T12:34:56Z") },
      error: null,
    });
    expect((await storage.list("users/")).data?.items.map((item) => item.key)).toEqual(["users/420/keep.txt"]);
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

  // No key starts with a slash, so the listing would be empty and the call would report a verified, empty folder.
  it("refuses a prefix no key can start with, instead of reporting the folder empty", async () => {
    const fixture = serverFixture({ files });
    expect((await fixture.cloudrop.api.deletePrefix("/users/42/")).error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        'No key can start with this prefix. Write it the way keys are written, such as "users/42/": no leading slash, no "." or ".." segment, no control characters, at most 1024 bytes.',
    });
    expect(fixture.storageCalls).toEqual([]);
  });

  it("deletes nothing when the listing returns a key outside the prefix", async () => {
    const deleteMany = vi.fn<StorageDriver["deleteMany"]>();
    const fixture = withStorage({
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
    const fixture = withStorage({
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
    const fixture = withStorage({
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
    const fixture = withStorage({
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
    const fixture = withStorage({ list: async () => fail(down) });
    expect((await fixture.cloudrop.api.deletePrefix("users/42/")).error).toBe(down);
  });
});
