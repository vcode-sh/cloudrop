import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing/memory-store.ts";
import { recordingLogger, serverFixture } from "../testing/server-fixture.ts";
import { leaseStore, owned } from "../testing/store-fixture.ts";
import { createCloudrop } from "./cloudrop.ts";
import { allowAnyone, route, routeFor } from "./route.ts";

const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });
const { storage } = serverFixture({ files });
const SECRET = "test-secret-0123456789abcdef0123456789";

/** createCloudrop with sound defaults and the given options, called the way plain JavaScript may call it. */
function create(options: Record<string, unknown>) {
  return () =>
    createCloudrop({ storage, secret: SECRET, routes: { files }, ...options } as Parameters<typeof createCloudrop>[0]);
}

describe("createCloudrop with a store: configuration errors", () => {
  const store = memoryStore();
  it.for<{ name: string; make: () => unknown; message: string }>([
    {
      name: "a store missing a method",
      make: create({ store: { ...store, claim: undefined } }),
      message:
        "store must be a CloudropStore, such as sqlStore(...) from cloudrop/adapters/sql. Its claim method is missing.",
    },
    {
      name: "quota without a store",
      make: create({ quota: () => 1 }),
      message: "quota needs a database store to count usage. Pass store to createCloudrop, or remove quota.",
    },
    {
      name: "completionLeaseMs without a store",
      make: create({ completionLeaseMs: 60_000 }),
      message: "completionLeaseMs needs a database store. Pass store to createCloudrop, or remove completionLeaseMs.",
    },
    {
      name: "a quota that is not a function",
      make: create({ store, quota: 1000 }),
      message: "quota must be a function from an owner to their limit in bytes, or null for no limit.",
    },
    {
      name: "a lease of 0",
      make: create({ store, completionLeaseMs: 0 }),
      message:
        "completionLeaseMs must be a whole number of milliseconds from 1000 to 2592000000 (30 days), such as 300000.",
    },
    // The claim and the sweep subtract the lease from the time: a lease this long gave a date no database stores, and
    // every /complete and sweep threw "Invalid time value" (M11-R63).
    {
      name: "a lease of the largest safe integer",
      make: create({ store, completionLeaseMs: Number.MAX_SAFE_INTEGER }),
      message:
        "completionLeaseMs must be a whole number of milliseconds from 1000 to 2592000000 (30 days), such as 300000.",
    },
    {
      name: "a lease one millisecond over 30 days",
      make: create({ store, completionLeaseMs: 2_592_000_001 }),
      message:
        "completionLeaseMs must be a whole number of milliseconds from 1000 to 2592000000 (30 days), such as 300000.",
    },
    {
      name: "a lease that is not a number",
      make: create({ store, completionLeaseMs: Number.NaN }),
      message:
        "completionLeaseMs must be a whole number of milliseconds from 1000 to 2592000000 (30 days), such as 300000.",
    },
    {
      name: "a route with owner and no store",
      make: create({ routes: { owned } }),
      message: 'Route "owned": owner needs a database store. Pass store to createCloudrop, or remove owner.',
    },
    {
      name: "a replacing route and no store",
      make: create({
        routes: { avatar: route({ accept: "image/*", maxSize: 1, replace: true, authorize: allowAnyone }) },
      }),
      message:
        'Route "avatar": replace needs a database store, which deletes the previous file when the next one completes. Pass store to createCloudrop, or remove replace.',
    },
    {
      name: "a replacing route without owner",
      make: create({
        store,
        routes: { avatar: route({ accept: "image/*", maxSize: 1, replace: true, authorize: allowAnyone }) },
      }),
      message:
        'Route "avatar": replace keeps one file per owner, so it needs owner. Add owner to the route, or remove replace.',
    },
    {
      name: "a replacing route that takes more than one file per upload",
      make: create({
        store,
        routes: {
          avatar: route(
            { accept: "image/*", maxSize: 1, maxFiles: 2, replace: true, authorize: () => ({ userId: "u1" }) },
            { owner: ({ userId }) => userId },
          ),
        },
      }),
      message: 'Route "avatar": replace keeps one file per owner, so maxFiles must be 1. Leave maxFiles out.',
    },
    {
      name: "a replace that is not true or false",
      make: create({
        store,
        routes: { avatar: route({ accept: "image/*", maxSize: 1, replace: "yes", authorize: allowAnyone } as never) },
      }),
      message: 'Route "avatar": replace must be true or false.',
    },
    {
      name: "a route with afterComplete and no store",
      make: create({
        routes: { notify: route({ accept: "*/*", maxSize: 1, authorize: allowAnyone }, { afterComplete: () => {} }) },
      }),
      message:
        'Route "notify": afterComplete needs a database store. Pass store to createCloudrop, or remove afterComplete.',
    },
    {
      name: "a route with onDelete and no store",
      make: create({
        routes: { docs: route({ accept: "*/*", maxSize: 1, authorize: allowAnyone }, { onDelete: () => {} }) },
      }),
      message: 'Route "docs": onDelete needs a database store. Pass store to createCloudrop, or remove onDelete.',
    },
    {
      name: "an onDelete that is not a function",
      make: create({
        store,
        routes: { docs: { definition: { accept: "*/*", maxSize: 1, authorize: allowAnyone, onDelete: "audit" } } },
      }),
      message: 'Route "docs": onDelete must be a function.',
    },
    {
      name: "an owner that is not a function",
      make: create({
        store,
        routes: { avatar: { definition: { accept: "*/*", maxSize: 1, authorize: allowAnyone, owner: "u1" } } },
      }),
      message: 'Route "avatar": owner must be a function.',
    },
  ])("throws INVALID_CONFIG for $name", ({ make, message }) => {
    expect(make).toThrow(expect.objectContaining({ code: "INVALID_CONFIG", message }));
  });

  it("refuses owner and afterComplete in route()'s first argument, naming the second", () => {
    expect(() => route({ accept: "*/*", maxSize: 1, authorize: allowAnyone, owner: () => "u1" } as never)).toThrow(
      "route(): owner belongs in the second argument, which holds prefix, key, owner, onComplete, afterComplete and onDelete: route({ accept, maxSize, authorize }, { owner }).",
    );
  });
});

describe("createCloudrop with a store: branded routes", () => {
  it("accepts a route from a store's own route() and plain routes beside it", () => {
    const store = memoryStore();
    const branded = routeFor<{ tx: unknown }>(store)({ accept: "*/*", maxSize: 1, authorize: allowAnyone });
    expect(create({ store, routes: { branded, files } })).not.toThrow();
  });

  it.for([
    { name: "another store", store: memoryStore() },
    { name: "no store", store: undefined },
  ])("refuses a route from a store's route() given $name", ({ store }) => {
    const branded = routeFor<{ tx: unknown }>(memoryStore())({ accept: "*/*", maxSize: 1, authorize: allowAnyone });
    expect(create({ store, routes: { branded } })).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "Route \"branded\" was made by another store's route(), so its onComplete expects that store's tx. Pass that store to createCloudrop, or build the route with route().",
      }),
    );
  });

  it("refuses a branded route when its store has no transaction", () => {
    const store = leaseStore();
    const branded = routeFor<{ tx: unknown }>(store)({ accept: "*/*", maxSize: 1, authorize: allowAnyone });
    expect(create({ store, routes: { branded } })).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          'Route "branded" expects a tx in onComplete, but the store has no transaction. Build the store with transaction: true, or build the route with route().',
      }),
    );
  });
});

describe("createCloudrop with a store: warnings", () => {
  it("warns once, naming them, when quota is set and some routes define no owner", () => {
    const logger = recordingLogger();
    create({ store: memoryStore(), quota: () => 1, logger, routes: { files, owned, other: files } })();
    expect(logger.warnings).toEqual([
      "cloudrop: quota is set, but routes files, other define no owner, so their uploads count against no limit. Add owner to those routes.",
    ]);
  });
});

describe("api.checkBucket with a store", () => {
  it("reports the missing abort-incomplete rule as required", async () => {
    const fixture = serverFixture(
      { files },
      { store: memoryStore(), bucketConfig: { lifecycle: "<LifecycleConfiguration></LifecycleConfiguration>" } },
    );
    expect((await fixture.cloudrop.api.checkBucket({ origins: [] })).data?.lifecycle).toEqual({
      status: "problem",
      message:
        "No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored. With a store it is required: an upload created just before a crash has no row to clean it up. Add one (R2 creates a 7-day rule by default).",
    });
  });
});
