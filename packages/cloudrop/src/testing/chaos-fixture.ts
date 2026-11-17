// The chaos lane's fixture: the real cloudrop server, its S3 storage pointed at the fault-injecting proxy in front of
// RustFS, and the real client on the fetch transport. App calls reach cloudrop.handler in process, as a same-origin
// browser sends them; bucket calls go over the network through the proxy, so presigned URLs name it and stay valid.
// The oracle reads RustFS directly (chaos-bucket.ts). Design: docs/superpowers/specs/2026-11-17-chaos-design.md §3-§4;
// plan audit I1, I2, I6, M2, M3. The server is built in chaos-server.ts; `useChaosFixture({ store: true })` gives it a
// database store, and app faults (chaos-app.ts) lose its answers. Run through `bun run test:chaos`.

import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { UploadJob } from "../client/types.ts";
import { type ClientOptions, createCloudropClient } from "../client.ts";
import type { Result } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import type { FileApi } from "../server/api.ts";
import { type AppRule, appTransport } from "./chaos-app.ts";
import {
  chaosStorage,
  clearPrefix,
  createBucket,
  expectStoredFile,
  type OpenUpload,
  openUploads,
  rustfsEndpoint,
} from "./chaos-bucket.ts";
import { type ChaosProxy, startChaosProxy } from "./chaos-proxy.ts";
import {
  type ChaosCloudrop,
  type ChaosStore,
  type ChaosStoreServer,
  chaosCloudrop,
  chaosStoreServer,
} from "./chaos-server.ts";
import { APP_ORIGIN, type RecordingLogger, recordingLogger } from "./server-fixture.ts";

/** One presigned PUT: below the fixture's 8 MiB multipart threshold. */
export const SINGLE_FILE_SIZE: number = MiB;
/** Three parts of 8, 8 and 4 MiB, under the client's four concurrent PUTs (audit M2). */
export const MULTIPART_FILE_SIZE: number = 20 * MiB;

const BASE_PATH = `${APP_ORIGIN}/api/cloudrop`;

/** The calls the rows make, on the "files" route, which takes no metadata and returns no result of its own. */
export interface ChaosClient {
  start(route: "files", files: File | File[]): UploadJob<null>;
  upload(route: "files", file: File): Promise<Result<CompleteResponse<null>>>;
}

export interface ChaosFixture {
  proxy: ChaosProxy;
  /** What the server logged: rows check that storage text stays out of messages and reaches the logger. */
  logger: RecordingLogger;
  /** "chaos/<uuid>/": every key of this fixture starts with it. */
  prefix: string;
  /**
   * A client of the "files" route on the fetch transport, persisting nothing unless `options` says so. Its calls end
   * with the test: reset() cancels them, and the client's requests from then on fail before they leave it.
   */
  client(options?: Omit<ClientOptions, "fetch" | "basePath">): ChaosClient;
  /**
   * Ends the clients' calls as a closed tab would: nothing more of them reaches the app or the bucket, not even the
   * /abort a cancel sends. Clients made after it work.
   */
  closeTab(): void;
  /** What reached the bucket through the proxy, in start order: "PUT part 2 reset", "CompleteMultipartUpload 200". */
  bucketRequests(): string[];
  /**
   * The client's calls to the app in order, as "POST /sign 200". /sign presigns locally and never reaches the bucket,
   * so a renewal or a new ticket shows here and not in `bucketRequests` (spec §4 rows 1, 3, 4, 7, 8).
   */
  appRequests(): string[];
  /** The bodies of the app's error answers, in order, as the client got them: rows read a message word for word. */
  appErrors(): unknown[];
  /** Loses the server's answers to the next calls these rules name, once each (chaos-app.ts). */
  faultApp(rules: AppRule[]): void;
  /** The server's file API: the store rows call usage, revokeUploads and sweep through it. */
  api: FileApi;
  /** Waits up to `timeoutMs` until `appRequests()` holds `call`, such as "POST /abort 200" (a background /abort). */
  waitForApp(call: string, timeoutMs?: number): Promise<void>;
  /** The object under `key` is exactly `file`: size and SHA-256, read from RustFS directly. */
  expectStored(key: string, file: Blob): Promise<void>;
  /** Multipart uploads open under the prefix, from RustFS directly. */
  uploadsLeft(): Promise<OpenUpload[]>;
  /** Keys of the objects stored under the prefix, from RustFS directly: `[]` proves nothing was stored. */
  objectsLeft(): Promise<string[]>;
  /** No multipart upload is open under the prefix. */
  expectNoUploadsLeft(): Promise<void>;
  /**
   * Cancels the test's client calls, so a red row's job cannot reach the next row's logs, then clears the rules,
   * random mode, held requests, the prefix's uploads and objects, the logs and the logger.
   */
  reset(): Promise<void>;
  /** Clears the prefix and stops the proxy. */
  stop(): Promise<void>;
}

/** The fixture with a database store: its counters, its hold on onComplete, and its tables. */
export interface ChaosStoreFixture extends ChaosFixture {
  store: ChaosStore;
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
async function startChaosFixture(stored?: ChaosStoreServer): Promise<ChaosFixture & { store?: ChaosStore }> {
  const endpoint = rustfsEndpoint();
  await createBucket(endpoint);
  const direct = chaosStorage(endpoint);
  // From crypto, not Math.random: the lane stubs that to 0, which would give every run the same prefix (audit M3).
  const prefix = `chaos/${crypto.randomUUID()}/`;
  const proxy = await startChaosProxy(endpoint);
  const logger = recordingLogger();
  const cloudrop = chaosCloudrop(chaosStorage(proxy.url), prefix, logger, stored);
  const app = appTransport(cloudrop.handler, BASE_PATH, APP_ORIGIN);

  // One per test: reset() aborts it, which cancels the test's calls. A cancelled job still sends its /abort, for a file
  // failed with a kept upload too, so a client's fetch refuses everything once its test has ended.
  let testRun = new AbortController();
  const closeTab = () => {
    testRun.abort(new Error("The tab was closed."));
    testRun = new AbortController();
  };
  const uploadsLeft = () => openUploads(endpoint, prefix);

  return {
    proxy,
    logger,
    prefix,
    store: stored?.hooks,
    api: cloudrop.api,
    client(options) {
      const { signal } = testRun;
      const client = createCloudropClient<ChaosCloudrop>({
        persist: false,
        ...options,
        fetch: app.fetchUntil(signal),
        basePath: BASE_PATH,
      });
      return {
        start: (route, files) => client.start(route, files, { signal }),
        upload: (route, file) => client.upload(route, file, { signal }),
      };
    },
    closeTab,
    bucketRequests: () => proxy.log().map((entry) => `${entry.label} ${entry.outcome}`),
    appRequests: app.requests,
    appErrors: app.errors,
    faultApp: app.setFaults,
    waitForApp: (call, timeoutMs = 5000) =>
      vi.waitFor(
        () => {
          const seen = app.requests();
          if (!seen.includes(call)) throw new Error(`The client has not got "${call}". Seen: ${seen}.`);
        },
        { timeout: timeoutMs, interval: 10 },
      ),
    expectStored: (key, file) => expectStoredFile(direct, key, file),
    uploadsLeft,
    async objectsLeft() {
      const listed = await direct.list(prefix);
      if (listed.error) throw listed.error;
      return listed.data.items.map((item) => item.key);
    },
    async expectNoUploadsLeft() {
      expect(await uploadsLeft()).toEqual([]);
    },
    async reset() {
      closeTab();
      proxy.set([]);
      proxy.random(null);
      proxy.release();
      // A completion a red row left waiting, or one whose answer was lost, finishes before the tables are emptied.
      stored?.freeHeld();
      await app.settled();
      await clearPrefix(direct, endpoint, prefix);
      proxy.clearLog();
      app.clear();
      stored?.reset();
      logger.errors.length = 0;
      logger.warnings.length = 0;
    },
    async stop() {
      try {
        proxy.release();
        await clearPrefix(direct, endpoint, prefix);
      } finally {
        stored?.close();
        await proxy.stop();
      }
    },
  };
}

/**
 * Registers the lane's hooks in the calling file or describe block and returns its fixture, usable from the first
 * test: started once before all (teardown registered with it), `Math.random` stubbed to 0 for every test (M3-K3),
 * and reset after each, so every test starts with no rules, empty logs and an empty prefix. A request already in
 * flight at the reset still lands in the next test's logs, so a row that triggers a background /abort waits for it
 * before it ends (audit M1) with `waitForApp("POST /abort 200")`: that call is recorded after the /abort's last storage
 * call, while the call's proxy entry is logged as the handler is still answering.
 */
export function useChaosFixture(): ChaosFixture;
export function useChaosFixture(options: { store: true }): ChaosStoreFixture;
export function useChaosFixture(options?: { store: true }): ChaosFixture {
  const fixture = {} as ChaosStoreFixture;
  beforeAll(async () => {
    Object.assign(fixture, await startChaosFixture(options?.store ? chaosStoreServer() : undefined));
    return () => fixture.stop();
  });
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // The sweep row moves the server's clock with fake Date.
    vi.useRealTimers();
    await fixture.reset();
  });
  return fixture;
}
