# Testing your app

`cloudrop/testing` runs your upload server and the real client in one process, in your own test runner, with no
bucket, browser or network. Your tests call `client.upload()` as your page does, and then read what landed in the
bucket. Use it to test what is yours: who `authorize` lets in, the metadata your schema takes, your quotas, what
`onComplete` returns, and how a large file goes through.

It works in Vitest, Bun's test runner and Node's `node:test`; the examples below are Vitest. They are the repository's
own tests (`packages/cloudrop/src/testing.guide.test.ts`), so they run as written. This page is for testing an app
that uses cloudrop; for the lanes that test cloudrop itself, see [Testing](testing.md).

## Set up

```bash
npm i -D vitest
```

Three functions do the work:

- `testBucket()` is an in-process bucket with R2's measured rules: equal part sizes, the 7-day limit on presigned URLs,
  create-only writes. It checks every request's signature, so a request signed for another bucket, after its expiry
  or with changed headers is refused. Pass `bucket.storage` to `createCloudrop`.
- `testClient(cloudrop, { bucket })` is the real `cloudrop/client` client, wired to `cloudrop.handler` and the bucket.
  `headers` stands in for the session a browser's cookies would carry.
- `memoryStore()` is an in-memory [database store](store.md), for an app that uses `owner`, `quota`, `afterComplete`
  or `replace`.

The examples share these imports and this setup. `signedIn` stands in for your app's session lookup: in your tests,
import your real routes instead. A route built with your database store's `store.route` belongs to that store; see
[`memoryStore`](#memorystoreoptions) for those.

```ts
import { expect, test } from "vitest";
import { createCloudrop, route, type StandardSchema, unauthorized } from "cloudrop";
import { memoryStore, testBucket, testClient } from "cloudrop/testing";
```

```ts
const secret = "a-test-secret-of-at-least-32-characters";

// Your app's session lookup; here the user is whoever the "session" cookie names.
function signedIn({ request }: { request: Request }) {
  const userId = /(?:^|; )session=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  return userId ? { userId } : unauthorized("Sign in to upload.");
}

const avatar = route(
  { accept: "image/*", maxSize: "1MB", authorize: signedIn },
  { prefix: ({ userId }) => `users/${userId}/avatars` },
);

const png = (name: string, bytes = 100) => new File([new Uint8Array(bytes)], name, { type: "image/png" });
```

## `authorize`: who may upload

A signed-in user's file lands under the folder the route's `prefix` builds:

```ts
test("stores a signed-in user's avatar under their folder", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { avatar } });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });

  const { data, error } = await client.upload("avatar", png("me.png", 512));

  expect(error).toBeNull();
  expect(data?.file.key).toMatch(/^users\/alice\/avatars\/\w+\.png$/);
  expect(bucket.object(data?.file.key ?? "")?.size).toBe(512);
});
```

A request without a session is refused with the message your `unauthorized()` gave, and nothing reaches the bucket:

```ts
test("refuses a signed-out user and stores nothing", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { avatar } });
  const client = testClient(cloudrop, { bucket }); // no session cookie

  const { error } = await client.upload("avatar", png("me.png"));

  expect(error?.code).toBe("UNAUTHORIZED");
  expect(error?.message).toBe("Sign in to upload.");
  expect(bucket.keys()).toEqual([]);
});
```

## Metadata

The route's schema checks the metadata the client sends. A real app passes a zod, valibot or arktype schema; the
example writes a small Standard Schema by hand so that it needs no library:

```ts
// Any Standard Schema: in your app, z.object({ albumId: z.string().min(1) }) from zod, or valibot's or arktype's.
const album: StandardSchema<{ albumId: string }> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) => {
      const albumId = (value as { albumId?: unknown } | undefined)?.albumId;
      return typeof albumId === "string" && albumId !== ""
        ? { value: { albumId } }
        : { issues: [{ message: "Choose an album.", path: ["albumId"] }] };
    },
  },
};
const photo = route(
  { accept: "image/*", maxSize: "1MB", metadata: album, authorize: signedIn },
  { prefix: ({ userId, metadata }) => `users/${userId}/albums/${metadata.albumId}` },
);
```

```ts
test("refuses a photo without an album", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { photo } });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });

  const { error } = await client.upload("photo", png("cat.png"), { metadata: { albumId: "" } });

  expect(error?.code).toBe("INVALID_METADATA");
  expect(error?.message).toBe("The metadata is not valid: Choose an album. (at albumId). Correct it and try again.");
  expect(bucket.keys()).toEqual([]);
});
```

## A quota, with a store

`memoryStore()` keeps rows and usage the way the shipped adapters do, so `quota`, `owner` and `cloudrop.api.usage`
behave as with your database:

```ts
test("refuses a file that would take a user past their quota", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({
    storage: bucket.storage,
    secret,
    store: memoryStore(),
    quota: () => 1000, // bytes per owner
    routes: {
      files: route(
        { accept: "*/*", maxSize: "1MB", authorize: signedIn },
        { prefix: ({ userId }) => `users/${userId}/files`, owner: ({ userId }) => userId },
      ),
    },
  });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });
  const file = (name: string) => new File([new Uint8Array(600)], name, { type: "text/plain" });

  expect((await client.upload("files", file("first.txt"))).error).toBeNull();
  const { error } = await client.upload("files", file("second.txt"));

  expect(error?.code).toBe("QUOTA_EXCEEDED");
  expect((await cloudrop.api.usage("alice")).data).toEqual({ reservedBytes: 0, activeBytes: 600, files: 1 });
});
```

## `onComplete`

What `onComplete` returns reaches the client as `data.data`:

```ts
test("answers the client with what onComplete returned", async () => {
  const saved: string[] = [];
  const bucket = testBucket();
  const cloudrop = createCloudrop({
    storage: bucket.storage,
    secret,
    routes: {
      avatar: route(
        { accept: "image/*", maxSize: "1MB", authorize: signedIn },
        {
          onComplete: async ({ file, userId }) => {
            saved.push(`${userId}: ${file.name}`); // your app's database write
            return { owner: userId, bytes: file.size };
          },
        },
      ),
    },
  });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });

  const { data } = await client.upload("avatar", png("me.png", 300));

  expect(data?.data).toEqual({ owner: "alice", bytes: 300 });
  expect(saved).toEqual(["alice: me.png"]);
});
```

## A multipart file

Files above `multipartThreshold` go up in parts, as in the browser. Lower the threshold in the test so a few MiB are
enough; parts are 8 MiB below 256 MiB, so 9 MiB makes two:

```ts
test("uploads a file larger than multipartThreshold in parts and stores every byte", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({
    storage: bucket.storage,
    secret,
    multipartThreshold: "8MB", // the default is 64 MiB; a small threshold keeps the test fast
    routes: { videos: route({ accept: "video/*", maxSize: "1GB", authorize: signedIn }) },
  });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });
  // 9 MiB: an 8 MiB part and a 1 MiB one.
  const bytes = new Uint8Array(9 * 1024 * 1024).map((_, index) => index % 251);

  const { data, error } = await client.upload("videos", new File([bytes], "clip.mp4", { type: "video/mp4" }));

  expect(error).toBeNull();
  const stored = bucket.object(data?.file.key ?? "");
  expect(stored?.parts).toBe(2);
  expect(stored?.size).toBe(bytes.byteLength);
  // Every byte in place; toEqual would compare the 9 MiB one by one and take most of a second.
  expect(stored?.body.every((byte, index) => byte === bytes[index])).toBe(true);
  expect(bucket.pendingUploads()).toBe(0);
});
```

## What differs from a browser and a real bucket

The client is the real one, so progress, retries, multipart, `abort()` and `close()` run their real code. What a test
cannot see:

- **Your framework.** The client reaches `cloudrop.handler` directly. Your route file, the adapter
  (`toNextHandler`, `toNodeHandler`) and middleware in front of it, such as a body parser that reads the body first,
  do not run, so a test passes even when the handler is mounted at the wrong path. Check that the `basePath` of your
  page's `createCloudropClient`, your mount and `createCloudrop` agree.
- **The page's origin.** The client runs on `http://localhost` and reaches the server there, as a same-origin page:
  each request carries `Origin: http://localhost`, whatever `headers` says. A cross-origin setup and `trustedOrigins`
  are not exercised; see [Deployment](deployment.md) for those.
- **Cookies.** A browser sends your session cookie by itself; here `headers` does it, for every request to the server
  and never for the bucket, as the browser does. `headers` can be a function, called before each request.
- **Bucket CORS.** The test bucket answers every request; a real bucket refuses a browser's `PUT` that its CORS rule
  does not allow. Check the rule on the real bucket with [`checkBucket`](bucket-setup.md).
- **Upload progress.** Bucket `PUT`s go through `fetch`, not `XMLHttpRequest`, so progress moves a whole part at a
  time, as in a browser client created with a `fetch` option. This also keeps a jsdom or happy-dom environment, which
  has an `XMLHttpRequest` of its own, from sending the bytes anywhere.
- **Resume after reload.** The client keeps nothing in IndexedDB: `resumable()` lists nothing, so one test's
  unfinished upload never shows in the next.
- **The network.** Nothing is slow, dropped or refused on the way.
- **R2 itself.** The bucket checks signatures with cloudrop's own signer, so it proves the request is signed as cloudrop
  signs, not that R2 accepts it. cloudrop's own test lanes check that against R2.
- **The clock.** The server and the bucket read the same clock, so `vi.useFakeTimers({ toFake: ["Date"] })` and
  `vi.setSystemTime()` fix the date for both.

## API

### `testBucket(options?)`

| Option | What it does |
| --- | --- |
| `publicUrl` | Where the bucket is served publicly, such as `"https://cdn.example.com"`, as in `r2({ publicUrl })`. Files on public routes get `file.url` under it. |
| `cors`, `lifecycle` | The bucket's CORS and lifecycle configuration as S3 XML, for tests of `cloudrop.api.checkBucket()`. Once either is given, the other reads as not configured. With neither, both read as refused, as with an R2 token that cannot read them. |

| Member | What it is |
| --- | --- |
| `storage` | The driver for `createCloudrop({ storage })`: `r2()` pointed at this bucket. |
| `fetch` | Reaches the bucket with a signed request, such as a URL from `cloudrop.api.getUrl()`. A `publicUrl` is not served: read a public file with `object(key)`. |
| `object(key)` | The stored object, or `null`: `key`, `size`, `type`, `disposition`, `metadata` (the `x-amz-meta-*` headers without the prefix), `parts` (`null` for a single `PUT`), `body` (a copy of the bytes) and `uploadedAt`. |
| `keys()` | Every stored key, sorted. |
| `pendingUploads()` | Multipart uploads started and neither completed nor aborted. `0` after a test means none was left behind. |

### `testClient(cloudrop, options)`

Returns a `CloudropClient`, typed from your server as `createCloudropClient<typeof cloudrop>()` would be.

| Option | What it does |
| --- | --- |
| `bucket` | Required: the test bucket the server stores in. |
| `headers` | Headers for every request to the server, never to the bucket: an object such as `{ cookie: "session=alice" }`, or a function, possibly async, that returns them. `origin` is always `http://localhost`. |
| `basePath` | The server's `basePath`: a path without a trailing slash. Default `"/api/cloudrop"`. |

A missing `bucket`, or a `basePath` that is not a path, throws `INVALID_CONFIG`.

### `memoryStore(options?)`

`memoryStore()`, or `memoryStore({ transaction: false })`, returns a store without transactions: `onComplete` runs under
a lease, as with `sqlStore(executor)`. `memoryStore({ transaction: true })` adds `transaction` and `store.route`, as
`sqlStore(executor, { transaction: true })` does; `onComplete` of a route built with `store.route` receives `tx`, which
is `undefined`, since there is no database to write through. A route built with another store's `store.route`, such as
your database store's, is refused by `createCloudrop`; build the routes your tests share with plain `route()`, or from a
function that takes the store. Test the writes your `onComplete` makes through `tx` against your real database.

Each store is empty when created; create one per test.
