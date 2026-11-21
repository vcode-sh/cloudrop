// The cloudrop/testing entry: an app tests its routes, its store and a whole upload in its own test runner, with no
// bucket, browser or network (M9-T1). The build keeps the imports of ./index.ts and ./client.ts as imports of the
// published entries (tsdown.config.ts), so this entry shares their code and classes and adds none to them (M9-T2).

import { type ClientOptions, type CloudropClient, createCloudropClient } from "./client.ts";
import {
  type Cloudrop,
  CloudropError,
  type CloudropStore,
  type FetchLike,
  type InferableCloudrop,
  type RouteCallbacks,
  type RouteFunction,
  r2,
  route,
  type StorageDriver,
  type TransactionalStore,
} from "./index.ts";
import { createFakeR2 } from "./testing/fake-r2.ts";
import { memoryStore as createMemoryStore } from "./testing/memory-store.ts";

export interface TestBucketOptions {
  /** Where the bucket is served publicly, such as "https://cdn.example.com", as in `r2({ publicUrl })`. Default none. */
  publicUrl?: string;
  /**
   * The bucket's CORS configuration as S3 XML, for tests of `api.checkBucket`. Once `cors` or `lifecycle` is given, the
   * other one reads as not configured; with neither, both read as refused, as with an R2 object token (M9-T6).
   */
  cors?: string;
  /** The bucket's lifecycle configuration as S3 XML, for tests of `api.checkBucket`. */
  lifecycle?: string;
}

/** An object as the test bucket stores it. */
export interface TestObject {
  key: string;
  size: number;
  /** The stored Content-Type, or null. */
  type: string | null;
  /** The stored Content-Disposition, or null. */
  disposition: string | null;
  /** The `x-amz-meta-*` headers, without the prefix: `cloudrop-id` is the file's id. */
  metadata: Record<string, string>;
  /** How many parts a multipart upload stored it in; null for a single PUT. */
  parts: number | null;
  /** A copy of the stored bytes. */
  body: Uint8Array;
  uploadedAt: Date;
}

/** An in-process bucket that keeps R2's measured rules and checks every request's signature. */
export interface TestBucket {
  /** The driver to pass to `createCloudrop({ storage })`: `r2()` pointed at this bucket. */
  readonly storage: StorageDriver;
  /**
   * Reaches the bucket with a signed request, such as a URL from `api.getUrl`. A `publicUrl` is not served: read a
   * public file with `object(key)`.
   */
  readonly fetch: FetchLike;
  /** The object stored under `key`, or null. */
  object(key: string): TestObject | null;
  /** Every stored key, sorted. */
  keys(): string[];
  /** Multipart uploads started and neither completed nor aborted. */
  pendingUploads(): number;
}

export interface TestClientOptions {
  /** The test bucket the server stores in: the client's presigned PUTs go there. */
  bucket: TestBucket;
  /**
   * Headers for every request to the server, never to the bucket: the session a browser's cookies would carry, such as
   * `{ cookie: "session=alice" }`, or a function that returns them before each request. `origin` is always the page's
   * own, `http://localhost`, as a browser sends it.
   */
  headers?: ClientOptions["headers"];
  /**
   * The client's `account` option: the user the page shows, as the route's `owner` returns it. With a session in
   * `headers` that names someone else, a route with a store and `owner` refuses the upload with ACCOUNT_CHANGED.
   */
  account?: ClientOptions["account"];
  /** The server's `basePath`, a path without a trailing slash. Default "/api/cloudrop". */
  basePath?: string;
}

/** The bucket checks every signature with these, so they only need to agree with the driver's. */
const CREDENTIALS = { accessKeyId: "cloudrop-test-key", secretAccessKey: "cloudrop-test-secret" };
/** The origin of the page the test client runs on, and of the server it reaches (M9-T4). */
const PAGE_ORIGIN = "http://localhost";
// The brand createCloudrop reads to tie a route to its store; Symbol.for, so copies of cloudrop agree (server/route.ts).
const STORE = Symbol.for("cloudrop.store");
/** A path such as /api/cloudrop: no origin, trailing slash, query or fragment. */
const PATH = /^(?:\/[^/?#\s]+)+$/;

/** A bucket for tests, with no network: pass `bucket.storage` to `createCloudrop`, then read what landed. */
export function testBucket(options?: TestBucketOptions | null): TestBucket {
  // null counts as no options, as createCloudrop reads its own.
  const { publicUrl, cors, lifecycle } = options ?? {};
  const bucketConfig = cors === undefined && lifecycle === undefined ? undefined : { cors, lifecycle };
  const fake = createFakeR2({ bucket: "uploads", credentials: CREDENTIALS, bucketConfig });
  return {
    storage: r2({ bucket: "uploads", accountId: "0".repeat(32), ...CREDENTIALS, publicUrl, fetch: fake.fetch }),
    fetch: fake.fetch,
    object(key) {
      const stored = fake.object(key);
      if (!stored) return null;
      const { body, headers } = stored;
      return {
        key,
        size: body.byteLength,
        type: headers.type ?? null,
        disposition: headers.disposition ?? null,
        metadata: { ...headers.metadata },
        parts: stored.partCount ?? null,
        body: body.slice(),
        uploadedAt: new Date(stored.uploadedAt),
      };
    },
    keys: fake.keys,
    pendingUploads: fake.pendingUploads,
  };
}

/**
 * The real `cloudrop/client` client, wired to `cloudrop.handler` and the test bucket in-process. Requests to the server
 * arrive as a same-origin page sends them; bucket PUTs go through fetch, never XMLHttpRequest, and nothing is kept
 * for resuming after a reload (M9-T4, M9-T5). Throws INVALID_CONFIG without a bucket or with a basePath that is not
 * a path.
 */
export function testClient<TCloudrop extends InferableCloudrop>(
  cloudrop: TCloudrop & Pick<Cloudrop, "handler">,
  options: TestClientOptions,
): CloudropClient<TCloudrop> {
  const { bucket, headers, account, basePath = "/api/cloudrop" } = options ?? {};
  if (!bucket) {
    throw new CloudropError(
      "INVALID_CONFIG",
      "testClient needs the test bucket the server stores in: testClient(cloudrop, { bucket }).",
    );
  }
  if (typeof basePath !== "string" || !PATH.test(basePath)) {
    throw new CloudropError(
      "INVALID_CONFIG",
      'basePath must be the path the server is mounted at, such as "/api/cloudrop", with no origin and no trailing slash.',
    );
  }
  const server = `${PAGE_ORIGIN}${basePath}`;
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    if (!url.startsWith(`${server}/`)) return bucket.fetch(url, init);
    // A browser sets Origin itself on every POST, and a page cannot change it.
    const sent = new Headers(init.headers);
    sent.set("origin", PAGE_ORIGIN);
    const request = new Request(url, { method: init.method, headers: sent, body: init.body });
    // happy-dom's Request drops the headers a page may not set, cookie and origin among them, so the handler reads the
    // headers as they were sent, in every test environment (M11-R1).
    Object.defineProperty(request, "headers", { value: sent });
    return cloudrop.handler(request);
  };
  return createCloudropClient<TCloudrop>({ basePath: server, headers, account, fetch, persist: false });
}

/**
 * An in-memory database store with the guarantees of the shipped adapters, for tests of an app that uses `store`:
 * owners, `quota`, `afterComplete`, `replace` and the store's file API. With `{ transaction: true }` it has
 * `transaction` and `store.route`, like `sqlStore(executor, { transaction: true })`; its `tx` is undefined, since
 * there is no database to write through (M9-T7).
 */
export function memoryStore(options: { transaction: true }): TransactionalStore<undefined>;
export function memoryStore(options?: { transaction?: false } | null): CloudropStore;
export function memoryStore(options?: { transaction?: boolean } | null): CloudropStore<undefined>;
export function memoryStore(options?: { transaction?: boolean } | null): CloudropStore<undefined> {
  // The repository's own tests reach past the store (raw tables, injected failures); an app's test gets the store only.
  const {
    transaction,
    raw: _raw,
    injectFailure: _inject,
    failNextUsageWrite: _fail,
    appRows: _rows,
    ...methods
  } = createMemoryStore();
  if (!options?.transaction) return methods;
  const store = {
    ...methods,
    transaction: (run) => transaction((_tx, inner) => run(undefined, inner)),
  } as TransactionalStore<undefined>;
  // What routeFor (server/route.ts) does for the adapters, over the public route().
  store.route = ((policy, callbacks) => ({
    definition: { ...route(policy, callbacks as RouteCallbacks<object, unknown, unknown>).definition, [STORE]: store },
  })) as RouteFunction<{ tx: undefined }>;
  return store;
}
