// A client on the fake bucket with a fake IndexedDB and a fake navigator.locks, for the tests of what a page keeps of
// a multipart upload (client/persist.ts). It records every ticket /upload answered, every hash computed and every
// request let through, so that `drained()` can wait for a record still being made from its file's hash and for a lock
// let go when an /abort is answered. Never shipped.

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { type ClientOptions, createCloudropClient } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StandardSchema } from "../server/schema.ts";
import { clientFixture, type Fault, type FaultCall } from "./client-fixture.ts";
import { fakeIndexedDb } from "./fake-indexeddb.ts";
import { fakeLocks } from "./fake-locks.ts";
import { offsetBytes } from "./storage-contract.ts";

/** Takes any JSON metadata as it is. */
const anyMetadata: StandardSchema = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } };

/** Every ticket /upload answered, in order. */
export interface Issued {
  kind: "single" | "multipart";
  id: string;
  key: string;
  token: string;
  expiresAt: string;
}

/** The fingerprint hashes exactly this many bytes of a file over 128 KiB: its first and last 64 KiB. */
const EDGES = 128 * 1024;

export const LAST_MODIFIED = 1_763_200_000_000;
/** 16 MiB and 5 bytes: three parts of the 8 MiB plan. */
export const threeParts = (): File =>
  new File([offsetBytes(16 * MiB + 5)], "a.bin", { type: "application/octet-stream", lastModified: LAST_MODIFIED });
export const smallFile = (name: string): File => new File([offsetBytes(1000)], name, { type: "text/plain" });
/** 24 MiB and 5 bytes: four parts of the 8 MiB plan, the last one 5 bytes. */
export const FOUR_PARTS = 24 * MiB + 5;
export const fourParts = (): File =>
  new File([offsetBytes(FOUR_PARTS)], "b.bin", { type: "application/octet-stream", lastModified: LAST_MODIFIED });

/** Hex SHA-256 of offsetBytes(size), the bytes of every file above, hashed by node:crypto. */
export const bytesHash = (size: number): string => createHash("sha256").update(offsetBytes(size)).digest("hex");

/** The fingerprint spec §3.3 defines for a file of offsetBytes(size), hashed by node:crypto, not WebCrypto. */
export function edgeHash(size: number): string {
  const bytes = offsetBytes(size);
  return createHash("sha256")
    .update(bytes.subarray(0, 64 * 1024))
    .update(bytes.subarray(size - 64 * 1024))
    .digest("hex");
}

/** /complete answered by the server: the multipart upload is gone and nothing of it is stored. */
export const noSuchUpload = (): Response =>
  Response.json(
    {
      error: {
        code: "NO_SUCH_UPLOAD",
        message: "This upload was aborted or has expired. Start it again.",
        retryable: false,
      },
    },
    { status: 410 },
  );

/** The server's error answer, as server/http.ts writes it. */
export const serverError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message, retryable: false } }, { status });

/** The first answer of `faults`, tried in order. */
export const firstOf =
  (...faults: Fault[]): Fault =>
  async (call) => {
    for (const fault of faults) {
      const answer = await fault(call);
      if (answer) return answer;
    }
    return undefined;
  };

/** A fault that answers nothing and keeps the JSON body of every call labelled `label`, for the test to read. */
export function bodiesOf(label: string) {
  const bodies: unknown[] = [];
  const fault: Fault = (call) => {
    if (call.label === label) bodies.push(JSON.parse(String(call.init.body)));
    return undefined;
  };
  return { fault, bodies };
}

/** A request that never reached the server: NETWORK_ERROR, which for /complete leaves the doubt that it finished. */
export const unreachable = (): Promise<never> => Promise.reject(new TypeError("Failed to fetch"));

/** Holds the calls `matches` picks until open() (a held call whose signal fires rejects, as a browser's fetch does). */
export function gate(matches: (call: FaultCall) => boolean) {
  const waiting: (() => void)[] = [];
  const reached = Promise.withResolvers<void>();
  let open = false;
  const fault: Fault = (call) => {
    if (open || !matches(call)) return undefined;
    reached.resolve();
    return new Promise((resolve, reject) => {
      waiting.push(() => resolve(undefined));
      call.init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted.", "AbortError")));
    });
  };
  return {
    fault,
    /** Resolves once the first call was held. */
    reached: reached.promise,
    open() {
      open = true;
      for (const go of waiting.splice(0)) go();
    },
  };
}

export interface PersistSetup {
  /** Answers the fingerprint's hash in place of WebCrypto, or undefined to let it through. */
  hash?: () => Promise<ArrayBuffer> | undefined;
  fault?: Fault;
  options?: ClientOptions;
  /** A runtime without indexedDB, such as a Worker of an old browser. */
  noIndexedDb?: boolean;
  /** No navigator.locks, as on a page that is not a secure context, or one whose every request the browser refuses. */
  webLocks?: "missing" | "refused";
}

export function persistFixture({ hash, fault = () => undefined, options, noIndexedDb, webLocks }: PersistSetup = {}) {
  const db = fakeIndexedDb();
  const locks = fakeLocks();
  vi.stubGlobal("indexedDB", noIndexedDb ? undefined : db.indexedDB);
  // Node 24 has a real navigator.locks (audit M5): every test holds the fake's instead.
  vi.stubGlobal("navigator", webLocks === "missing" ? {} : { locks: locks.locks });
  if (webLocks === "refused") locks.refuse();
  const subtle = crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  // Every hash started and every request the fault let through, for drained().
  const pending: Promise<unknown>[] = [];
  let hashedFiles = 0;
  vi.spyOn(subtle, "digest").mockImplementation((algorithm, data) => {
    const isFile = (data as ArrayBuffer).byteLength === EDGES;
    if (isFile) hashedFiles += 1;
    const answer = (isFile ? hash?.() : undefined) ?? digest(algorithm, data);
    pending.push(answer);
    return answer;
  });
  const issued: Issued[] = [];
  // The ids of the files whose onComplete ran, in order: a probe of a finished upload runs it again (audit M8).
  const completed: string[] = [];
  const files = route(
    { accept: "*/*", maxSize: "100MB", metadata: anyMetadata, authorize: allowAnyone },
    {
      onComplete: ({ file }) => {
        completed.push(file.id);
        return null;
      },
    },
  );
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: async (call) => {
        let answer = await fault(call);
        if (!answer) {
          const forwarded = call.forward(call.init);
          pending.push(forwarded);
          answer = await forwarded;
        }
        if (call.label === "POST /upload") issued.push(...((await answer.clone().json()).files ?? []));
        return answer;
      },
    },
  );
  // Each multipart ticket of a persisting client hashes its file exactly once, once locked (audit C1, M3-U80, M3-U88).
  const persisting = options?.persist !== false && !noIndexedDb && !webLocks;
  const expectedHashes = () => (persisting ? issued.filter((ticket) => ticket.kind === "multipart").length : 0);
  return {
    db,
    locks,
    issued,
    completed,
    fixture,
    client: createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, ...options }),
    /**
     * The page reloads: the browser lets go of its locks, and a new client with the same options starts on the same
     * IndexedDB, server and bucket. The old client is left as it is: nothing it holds reaches the bucket any more.
     */
    reload(changed?: ClientOptions) {
      locks.releaseAll();
      return createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, ...options, ...changed });
    },
    /** Hex SHA-256 of the object the bucket stores at `key`, or null when there is none. */
    async storedHash(key: string): Promise<string | null> {
      const signed = await fixture.server.storage.presignGet(key, { expiresIn: 60 });
      const response = await fixture.server.fake.fetch(signed.data?.url ?? "", { method: "GET" });
      if (!response.ok) return null;
      return createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex");
    },
    /** How many files were hashed for a fingerprint. */
    hashedFiles: () => hashedFiles,
    /** The requests sent from now on. */
    from() {
      const start = fixture.requests.length;
      return () => fixture.requests.slice(start);
    },
    /**
     * Resolves once every multipart ticket's file has been hashed (counted, so a slow file read cannot slip past),
     * every hash and every request the fault let through has settled, and the store has gone quiet after them. A
     * request a fault holds is not waited for.
     */
    async drained() {
      while (hashedFiles < expectedHashes()) await db.settled();
      for (let seen = -1; seen !== pending.length; ) {
        seen = pending.length;
        await Promise.allSettled(pending);
        await db.settled();
      }
    },
  };
}

export const METADATA = { album: "Trip" };
export const nth = (label: string, n: number) => (call: FaultCall) => call.label === label && call.nth === n;
/** The page before the reload sends one PUT at a time: holding its PUT part 3 leaves parts 1 and 2 in the bucket. */
export const partThree: (call: FaultCall) => boolean = nth("PUT part 3", 1);

/**
 * One PUT at a time, so the order of requests is fixed. The page before the reload starts a four-part file with
 * METADATA and is interrupted once `held` holds a call; the new client lists that upload.
 */
export async function reloaded(held: ReturnType<typeof gate>, ...faults: Fault[]) {
  const setup = persistFixture({ fault: firstOf(held.fault, ...faults), options: { concurrency: 1 } });
  setup.client.start("files", fourParts(), { metadata: METADATA });
  await held.reached;
  await setup.drained();
  const client = setup.reload();
  const [upload] = (await client.resumable()).data ?? [];
  if (!upload) throw new Error("The page before the reload left no record.");
  return { ...setup, client, upload, sent: setup.from() };
}
