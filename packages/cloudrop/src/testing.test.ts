// What cloudrop/testing promises beyond the guide's examples (testing.guide.test.ts): the test client behaves as the
// real client does in a browser where that changes an app's test, and the test bucket and memory store keep the
// options and inspection they document.

import { afterEach, describe, expect, it, vi } from "vitest";
import { allowAnyone, createCloudrop, route } from "./index.ts";
import { contentChecks } from "./plugins.ts";
import { fakeIndexedDb } from "./testing/fake-indexeddb.ts";
import { fakeLocks } from "./testing/fake-locks.ts";
import { JPEG } from "./testing/file-samples.ts";
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

  // Testing through the app's own mount (M9-H105): a handler that never reaches cloudrop fails the upload.
  it("sends the server's requests to the handler it is given, so a wrong mount fails the test", async () => {
    const bucket = testBucket();
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });
    const wrongMount = () => Promise.resolve(new Response("Not Found", { status: 404 }));
    const client = testClient({ ...cloudrop, handler: wrongMount }, { bucket });

    const { error } = await client.upload("anyFile", text("a.txt", 1));

    expect([error?.code, error?.message, bucket.keys()]).toEqual([
      "SERVER_ERROR",
      "The upload server sent an answer this client cannot read (HTTP 404). Check that basePath points at the cloudrop handler and that the server runs the same cloudrop version.",
      [],
    ]);
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

  // An app tests the copy it builds from a refusal's `content` (M11-K5).
  it("gives a file contentChecks() refuses its error with `content`, and the bucket keeps nothing", async () => {
    const bucket = testBucket();
    const cloudrop = createCloudrop({
      storage: bucket.storage,
      secret,
      routes: { anyFile },
      plugins: [contentChecks()],
    });
    const photo = new File([JPEG], "photo.png", { type: "image/png" });

    const { error } = await testClient(cloudrop, { bucket }).upload("anyFile", photo);

    expect({ code: error?.code, content: error?.content, keys: bucket.keys() }).toEqual({
      code: "FILE_TYPE_NOT_ALLOWED",
      content: { declared: "image/png", detected: "image/jpeg", reason: "mismatch" },
      keys: [],
    });
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
      message:
        'basePath must be the path the server is mounted at, such as "/api/cloudrop", with no origin and no trailing slash.',
    },
    {
      name: "a basePath with a trailing slash",
      options: { basePath: "/api/cloudrop/" },
      message:
        'basePath must be the path the server is mounted at, such as "/api/cloudrop", with no origin and no trailing slash.',
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

  it("lists keys sorted and hands out copies, so a test cannot change what is stored", async () => {
    const bucket = testBucket();
    const named = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }, { key: ({ file }) => file.name });
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { named } });
    const client = testClient(cloudrop, { bucket });
    await client.upload("named", text("b.txt", 1));
    await client.upload("named", text("a.txt", 1));

    const first = bucket.object("a.txt");
    first?.body.fill(7);
    first?.uploadedAt.setTime(0);

    expect(bucket.keys()).toEqual(["a.txt", "b.txt"]);
    expect(bucket.object("a.txt")?.body).toEqual(new Uint8Array(1));
    expect(bucket.object("a.txt")?.uploadedAt.getTime()).not.toBe(0);
  });

  // The server signs with the date it reads and the bucket checks signatures against its own: they must be one clock.
  it("reads the clock the server reads, so a test can fix the date of an upload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-02-03T04:05:06Z"));
    const bucket = testBucket();
    const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { anyFile } });

    const { data } = await testClient(cloudrop, { bucket }).upload("anyFile", text("a.txt", 1));
    vi.setSystemTime(new Date("2031-02-04T00:00:00Z"));

    expect(bucket.object(data?.file.key ?? "")?.uploadedAt).toEqual(new Date("2031-02-03T04:05:06Z"));
  });

  it("serves the CORS and lifecycle rules it was given to checkBucket", async () => {
    const cors = `<CORSConfiguration><CORSRule><AllowedOrigin>https://app.example.com</AllowedOrigin>
      <AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader>
      </CORSRule></CORSConfiguration>`;
    const lifecycle = `<LifecycleConfiguration><Rule><ID>abort</ID><Status>Enabled</Status><Filter></Filter>
      <AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>
      </Rule></LifecycleConfiguration>`;
    const cloudrop = createCloudrop({ storage: testBucket({ cors, lifecycle }).storage, secret, routes: { anyFile } });

    const { data } = await cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });

    expect({ cors: data?.cors.status, lifecycle: data?.lifecycle.status }).toEqual({ cors: "ok", lifecycle: "ok" });
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

  // A store without `transaction` is the lease mode of CloudropStore: that absence is the contract.
  it("without transaction: true, has no transaction, so completions take a lease", () => {
    expect(Object.hasOwn(memoryStore(), "transaction")).toBe(false);
    expect(Object.hasOwn(memoryStore({ transaction: false }), "transaction")).toBe(false);
  });
});
