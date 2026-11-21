// The examples of docs/guide/testing-your-app.md, run in the unit lane. The guide shows this file's code with
// "cloudrop" and "cloudrop/testing" in place of the relative imports, and the last test fails when the two differ.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createCloudrop, route, type StandardSchema, unauthorized } from "./index.ts";
import { memoryStore, testBucket, testClient } from "./testing.ts";

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

test("stores a signed-in user's avatar under their folder", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { avatar } });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });

  const { data, error } = await client.upload("avatar", png("me.png", 512));

  expect(error).toBeNull();
  expect(data?.file.key).toMatch(/^users\/alice\/avatars\/\w+\.png$/);
  expect(bucket.object(data?.file.key ?? "")?.size).toBe(512);
});

test("refuses a signed-out user and stores nothing", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { avatar } });
  const client = testClient(cloudrop, { bucket }); // no session cookie

  const { error } = await client.upload("avatar", png("me.png"));

  expect(error?.code).toBe("UNAUTHORIZED");
  expect(error?.message).toBe("Sign in to upload.");
  expect(bucket.keys()).toEqual([]);
});

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

test("refuses a photo without an album", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { photo } });
  const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });

  const { error } = await client.upload("photo", png("cat.png"), { metadata: { albumId: "" } });

  expect(error?.code).toBe("INVALID_METADATA");
  expect(error?.message).toBe("The metadata is not valid: Choose an album. (at albumId). Correct it and try again.");
  expect(bucket.keys()).toEqual([]);
});

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
  const file = (name: string) => new File([new Uint8Array(600)], name, { type: "application/pdf" });

  expect((await client.upload("files", file("first.pdf"))).error).toBeNull();
  const { error } = await client.upload("files", file("second.pdf"));

  expect(error?.code).toBe("QUOTA_EXCEEDED");
  expect((await cloudrop.api.usage("alice")).data).toEqual({ reservedBytes: 0, activeBytes: 600, files: 1 });
});

test("refuses an upload from a page that shows another account", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({
    storage: bucket.storage,
    secret,
    store: memoryStore(),
    routes: {
      files: route({ accept: "*/*", maxSize: "1MB", authorize: signedIn }, { owner: ({ userId }) => userId }),
    },
  });
  // A page loaded for alice; `cookie` is the session the browser sends now.
  const alicesPage = (cookie: string) => testClient(cloudrop, { bucket, headers: { cookie }, account: "alice" });

  expect((await alicesPage("session=alice").upload("files", png("mine.png"))).error).toBeNull();
  // bob signed in in another tab.
  const { error } = await alicesPage("session=bob").upload("files", png("late.png"));

  expect(error?.code).toBe("ACCOUNT_CHANGED");
  expect((await cloudrop.api.usage("bob")).data?.files).toBe(0);
});

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

// Your app, as your server builds it: here a fetch handler that mounts cloudrop at /api/cloudrop, as Hono's
// app.on(["POST", "OPTIONS"], "/api/cloudrop/*", (c) => cloudrop.handler(c.req.raw)) does.
function createApp(cloudrop: { handler(request: Request): Promise<Response> }) {
  return {
    fetch: (request: Request) =>
      new URL(request.url).pathname.startsWith("/api/cloudrop/")
        ? cloudrop.handler(request)
        : Promise.resolve(new Response("Not Found", { status: 404 })),
  };
}

test("reaches cloudrop through the app's own mount", async () => {
  const bucket = testBucket();
  const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { avatar } });
  const app = createApp(cloudrop);
  // Every request to the server goes through app.fetch: the mount path and the middleware in front of it run.
  const client = testClient(
    { ...cloudrop, handler: (request) => app.fetch(request) },
    { bucket, headers: { cookie: "session=alice" } },
  );

  const { error } = await client.upload("avatar", png("me.png"));

  expect(error).toBeNull();
});

// Each TypeScript block of the guide is a piece of this file, so an example cannot change in one place only.
test("the guide shows this file's code", () => {
  const guide = readFileSync(new URL("../../../docs/guide/testing-your-app.md", import.meta.url), "utf8");
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map(([, code = ""]) =>
    code.replaceAll('"cloudrop/testing"', '"./testing.ts"').replaceAll('"cloudrop"', '"./index.ts"'),
  );
  expect(blocks.length).toBeGreaterThanOrEqual(8);
  expect(blocks.filter((block) => !source.includes(block))).toEqual([]);
});
