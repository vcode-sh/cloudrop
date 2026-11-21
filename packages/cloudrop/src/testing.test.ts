// What cloudrop/testing promises beyond the guide's examples (testing.guide.test.ts): the test client behaves as the
// real client does in a browser where that changes an app's test, and the test bucket and memory store keep the
// options and inspection they document.

import { afterEach, describe, expect, it, vi } from "vitest";
import { allowAnyone, createCloudrop, route } from "./index.ts";
import { fakeIndexedDb } from "./testing/fake-indexeddb.ts";
import { fakeLocks } from "./testing/fake-locks.ts";
import { memoryStore, testBucket, testClient } from "./testing.ts";

const secret = "a-test-secret-of-at-least-32-characters";
const anyFile = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone });
const text = (name: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type: "text/plain" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("testClient", () => {
  it("reaches the server as a same-origin page does: the Origin header the handler checks, and the URL's own", async () => {
    const seen: { origin: string | null; url: string }[] = [];
    const bucket = testBucket();
    const files = route({
      accept: "*/*",
      maxSize: "1MB",
      authorize: ({ request }) => {
        seen.push({ origin: request.headers.get("origin"), url: request.url });
        return {};
      },
    });
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { files } });

    expect((await testClient(cloudrop, { bucket }).upload("files", text("a.txt", 1))).error).toBeNull();
    expect(seen).toEqual([{ origin: "http://localhost", url: "http://localhost/api/cloudrop/upload" }]);
  });

  it("reaches a server mounted at another basePath", async () => {
    const bucket = testBucket();
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, basePath: "/uploads", routes: { anyFile } });
    const client = testClient(cloudrop, { bucket, basePath: "/uploads" });

    expect((await client.upload("anyFile", text("a.txt", 3))).error).toBeNull();
  });

  // In a jsdom or happy-dom environment the real client would send bucket PUTs through XMLHttpRequest, which cannot
  // reach the in-process bucket.
  it("sends bucket PUTs through fetch where XMLHttpRequest exists", async () => {
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        constructor() {
          throw new Error("The test client must not use XMLHttpRequest.");
        }
      },
    );
    const bucket = testBucket();
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });

    const { data } = await testClient(cloudrop, { bucket }).upload("anyFile", text("a.txt", 5));

    expect(bucket.object(data?.file.key ?? "")?.size).toBe(5);
  });

  it("cancels a multipart upload: the server aborts it and the bucket keeps nothing", async () => {
    const bucket = testBucket();
    const cloudrop = createCloudrop({
      storage: bucket.storage,
      secret,
      multipartThreshold: "8MB",
      routes: { anyFile },
    });
    const client = testClient(cloudrop, { bucket });
    const job = client.start("anyFile", text("big.txt", 11 * 1024 * 1024));
    // Cancels once the first part is stored, while the upload is still open in the bucket.
    const unsubscribe = job.subscribe(() => {
      if (job.getSnapshot().totals.bytes > 0) job.abort();
    });

    const { error } = await job.done;
    unsubscribe();

    expect(error?.code).toBe("ABORTED");
    expect({ keys: bucket.keys(), pending: bucket.pendingUploads() }).toEqual({ keys: [], pending: 0 });
  });

  // An app's tests would otherwise share one IndexedDB, so one test's unfinished upload would show in the next.
  it("keeps nothing for resuming after a reload, even where IndexedDB and Web Locks exist", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDb().indexedDB);
    vi.stubGlobal("navigator", { locks: fakeLocks().locks });
    const bucket = testBucket();
    const cloudrop = createCloudrop({
      storage: bucket.storage,
      secret,
      multipartThreshold: "8MB",
      routes: { anyFile },
    });
    const client = testClient(cloudrop, { bucket });
    const job = client.start("anyFile", text("big.txt", 9 * 1024 * 1024));
    // Stops the client once the first part is stored; a persisting client keeps the upload's record for resume().
    job.subscribe(() => {
      if (job.getSnapshot().totals.bytes > 0) void client.close();
    });

    await job.done;

    expect((await client.resumable()).data).toEqual([]);
  });

  it.each([
    {
      name: "no bucket",
      options: { bucket: undefined },
      message: "testClient needs the test bucket the server stores in: testClient(cloudrop, { bucket }).",
    },
    {
      name: "a basePath that is a URL",
      options: { basePath: "https://api.example.com/api/cloudrop" },
      message: 'basePath must be the path the server is mounted at, such as "/api/cloudrop".',
    },
  ])("refuses $name with INVALID_CONFIG", ({ options, message }) => {
    const bucket = testBucket();
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });
    expect(() => testClient(cloudrop, { bucket, ...options } as Parameters<typeof testClient>[1])).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", message }),
    );
  });
});

describe("testBucket", () => {
  it("gives files on a public route the publicUrl and keeps what the upload stored with the object", async () => {
    const bucket = testBucket({ publicUrl: "https://cdn.example.com" });
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });

    const { data } = await testClient(cloudrop, { bucket }).upload("anyFile", text("notes.txt", 4));
    const key = data?.file.key ?? "";

    expect(data?.file.url).toBe(`https://cdn.example.com/${key}`);
    expect(bucket.object(key)).toEqual({
      key,
      size: 4,
      type: "text/plain",
      disposition: "attachment; filename=\"notes.txt\"; filename*=UTF-8''notes.txt",
      metadata: { "cloudrop-id": data?.file.id },
      parts: null,
      body: new Uint8Array(4),
      uploadedAt: expect.any(Date),
    });
    expect(bucket.object("missing.txt")).toBeNull();
  });

  // The server signs with the date it reads and the bucket checks signatures against its own: they must be one clock.
  it("reads the clock the server reads, so a test can fix the date of an upload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-02-03T04:05:06Z"));
    const bucket = testBucket();
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });

    const { data } = await testClient(cloudrop, { bucket }).upload("anyFile", text("a.txt", 1));

    expect(bucket.object(data?.file.key ?? "")?.uploadedAt).toEqual(new Date("2031-02-03T04:05:06Z"));
  });

  it("serves the CORS rules it was given to checkBucket", async () => {
    const cors =
      "<CORSConfiguration><CORSRule><AllowedOrigin>https://app.example.com</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>";
    const bucket = testBucket({ cors });
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });

    const { data } = await cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });

    expect(data?.cors.status).toBe("problem");
  });
});

describe("memoryStore", () => {
  it("with transaction: true, gives onComplete of a store.route route the transaction", async () => {
    const store = memoryStore({ transaction: true });
    const bucket = testBucket();
    const avatar = store.route(
      { accept: "*/*", maxSize: "1MB", authorize: () => ({ userId: "alice" }) },
      { owner: ({ userId }) => userId, onComplete: (context) => ({ inTransaction: "tx" in context }) },
    );
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, store, routes: { avatar } });

    const { data } = await testClient(cloudrop, { bucket }).upload("avatar", text("a.txt", 2));

    expect(data?.data).toEqual({ inTransaction: true });
  });
});
