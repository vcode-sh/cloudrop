// The chaos lane's fixture: the real cloudrop server, its s3() storage pointed at the fault-injecting proxy in front of
// RustFS, and the real client on the fetch transport. App calls reach cloudrop.handler in process, as a same-origin
// browser sends them; bucket calls go over the network through the proxy, so presigned URLs name it and stay valid.
// The oracle reads RustFS directly (chaos-bucket.ts). Design: docs/superpowers/specs/2026-11-17-chaos-design.md §3-§4;
// plan audit I1, I2, I6, M2, M3. Run through `bun run test:chaos`.

import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { ClientFetch } from "../client/endpoints.ts";
import { type ClientOptions, type CloudropClient, createCloudropClient } from "../client.ts";
import { MiB } from "../rules.ts";
import { createCloudrop } from "../server/cloudrop.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StorageDriver } from "../storage/driver.ts";
import {
  chaosStorage,
  clearPrefix,
  createBucket,
  expectStoredFile,
  type OpenUpload,
  openUploads,
  rustfsEndpoint,
} from "./chaos-bucket.ts";
import { type ChaosEntry, type ChaosProxy, startChaosProxy } from "./chaos-proxy.ts";
import { APP_ORIGIN, type RecordingLogger, recordingLogger, SECRET } from "./server-fixture.ts";

/** One presigned PUT: below the fixture's 8 MiB multipart threshold. */
export const SINGLE_FILE_SIZE: number = MiB;
/** Three parts of 8, 8 and 4 MiB, under the client's four concurrent PUTs (audit M2). */
export const MULTIPART_FILE_SIZE: number = 20 * MiB;

const BASE_PATH = `${APP_ORIGIN}/api/cloudrop`;

function chaosCloudrop(storage: StorageDriver, prefix: string, logger: RecordingLogger) {
  return createCloudrop({
    storage,
    secret: SECRET,
    logger,
    // Every non-last part is 8 MiB whatever the threshold; this one makes a 20 MiB file go in three of them.
    multipartThreshold: "8MB",
    routes: {
      files: route({
        accept: ["application/octet-stream"],
        maxSize: "100MB",
        // The soak sends up to 20 files through one /upload.
        maxFiles: 20,
        authorize: allowAnyone,
        prefix: () => prefix,
      }),
    },
  });
}

export type ChaosCloudrop = ReturnType<typeof chaosCloudrop>;

export interface ChaosFixture {
  proxy: ChaosProxy;
  cloudrop: ChaosCloudrop;
  /** What the server logged: rows check that storage text stays out of messages and reaches the logger. */
  logger: RecordingLogger;
  /** "chaos/<uuid>/": every key of this fixture starts with it. */
  prefix: string;
  /** A client of the "files" route on the fetch transport, persisting nothing unless `options` says so. */
  client(options?: Omit<ClientOptions, "fetch" | "basePath">): CloudropClient<ChaosCloudrop>;
  /** What reached the bucket through the proxy, in start order: "PUT part 2 reset", "CompleteMultipartUpload 200". */
  bucketRequests(): string[];
  /** The first log entry `matches` accepts, waiting up to `timeoutMs` for it (a background /abort lands late, M1). */
  waitForEntry(matches: (entry: ChaosEntry) => boolean, timeoutMs?: number): Promise<ChaosEntry>;
  /** The object under `key` is exactly `file`: size and SHA-256, read from RustFS directly. */
  expectStored(key: string, file: Blob): Promise<void>;
  /** Multipart uploads open under the prefix, from RustFS directly. */
  uploadsLeft(): Promise<OpenUpload[]>;
  /**
   * No multipart upload is open under the prefix, except under the `allow`ed keys: those M3-U55 leaves to the
   * lifecycle rule, such as a retry's first ticket (audit C3).
   */
  expectNoUploadsLeft(options?: { allow?: readonly string[] }): Promise<void>;
  /** Clears the rules, random mode, held requests, the prefix's uploads and objects, the log and the logger. */
  reset(): Promise<void>;
  /** Clears the prefix and stops the proxy. */
  stop(): Promise<void>;
}

/**
 * A file of `size` bytes, the same for the same `seed`. The bytes never repeat at a part boundary, so parts sent in
 * the wrong place or twice change the stored SHA-256.
 */
export function chaosFile(size: number, seed = 1): File {
  const words = new Uint32Array(Math.ceil(size / 4));
  // xorshift32; never Math.random, which the lane stubs to 0.
  let state = seed >>> 0 || 1;
  for (let index = 0; index < words.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[index] = state >>> 0;
  }
  return new File([new Uint8Array(words.buffer, 0, size)], `chaos-${seed}.bin`, { type: "application/octet-stream" });
}

/** Starts the proxy in front of the lane's RustFS and a server on it; fails with what to run when RustFS is absent. */
export async function startChaosFixture(): Promise<ChaosFixture> {
  const endpoint = rustfsEndpoint();
  await createBucket(endpoint);
  const direct = chaosStorage(endpoint);
  // From crypto, not Math.random: the lane stubs that to 0, which would give every run the same prefix (audit M3).
  const prefix = `chaos/${crypto.randomUUID()}/`;
  const proxy = await startChaosProxy(endpoint);
  const logger = recordingLogger();
  const cloudrop = chaosCloudrop(chaosStorage(proxy.url), prefix, logger);

  const fetch: ClientFetch = (url, init) => {
    if (!url.startsWith(BASE_PATH)) return globalThis.fetch(url, init);
    init.signal?.throwIfAborted();
    const headers = { ...Object.fromEntries(new Headers(init.headers)), origin: APP_ORIGIN };
    return cloudrop.handler(new Request(url, { method: init.method, body: init.body, headers }));
  };
  const uploadsLeft = () => openUploads(endpoint, prefix);

  return {
    proxy,
    cloudrop,
    logger,
    prefix,
    client: (options) =>
      createCloudropClient<ChaosCloudrop>({ persist: false, ...options, fetch, basePath: BASE_PATH }),
    bucketRequests: () => proxy.log().map((entry) => `${entry.label} ${entry.outcome}`),
    waitForEntry: (matches, timeoutMs = 5000) =>
      vi.waitFor(
        () => {
          const found = proxy.log().find(matches);
          if (!found) throw new Error(`No such request reached the bucket. Seen: ${proxy.log().length} requests.`);
          return found;
        },
        { timeout: timeoutMs, interval: 10 },
      ),
    expectStored: (key, file) => expectStoredFile(direct, key, file),
    uploadsLeft,
    async expectNoUploadsLeft({ allow = [] } = {}) {
      const left = await uploadsLeft();
      expect(left.filter((upload) => !allow.includes(upload.key))).toEqual([]);
    },
    async reset() {
      proxy.set([]);
      proxy.random(null);
      proxy.release();
      await clearPrefix(direct, endpoint, prefix);
      proxy.clearLog();
      logger.errors.length = 0;
      logger.warnings.length = 0;
    },
    async stop() {
      try {
        proxy.release();
        await clearPrefix(direct, endpoint, prefix);
      } finally {
        await proxy.stop();
      }
    },
  };
}

/**
 * Registers the lane's hooks in the calling file or describe block and returns its fixture, usable from the first
 * test: started once before all (teardown registered with it), `Math.random` stubbed to 0 for every test (M3-K3),
 * and reset after each, so every test starts with no rules, an empty log and an empty prefix.
 */
export function useChaosFixture(): ChaosFixture {
  const fixture = {} as ChaosFixture;
  beforeAll(async () => {
    Object.assign(fixture, await startChaosFixture());
    return () => fixture.stop();
  });
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.reset();
  });
  return fixture;
}
