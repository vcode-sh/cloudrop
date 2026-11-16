// A client on the fake bucket with a fake IndexedDB and a fake navigator.locks, for the tests of what a page keeps of
// a multipart upload (client/persist.ts). It records every ticket /upload answered and every hash computed, so that
// `drained()` can wait for a record still being made from its file's hash. Never shipped.

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
const files = route({ accept: "*/*", maxSize: "100MB", metadata: anyMetadata, authorize: allowAnyone });

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
}

export function persistFixture({ hash, fault = () => undefined, options, noIndexedDb }: PersistSetup = {}) {
  const db = fakeIndexedDb();
  const locks = fakeLocks();
  vi.stubGlobal("indexedDB", noIndexedDb ? undefined : db.indexedDB);
  // Node 24 has a real navigator.locks (audit M5): every test holds the fake's instead.
  vi.stubGlobal("navigator", { locks: locks.locks });
  const subtle = crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  const hashes: Promise<unknown>[] = [];
  let hashedFiles = 0;
  vi.spyOn(subtle, "digest").mockImplementation((algorithm, data) => {
    const isFile = (data as ArrayBuffer).byteLength === EDGES;
    if (isFile) hashedFiles += 1;
    const answer = (isFile ? hash?.() : undefined) ?? digest(algorithm, data);
    hashes.push(answer);
    return answer;
  });
  const issued: Issued[] = [];
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: async (call) => {
        if (call.label !== "POST /upload") return fault(call);
        const answer = (await fault(call)) ?? (await call.forward(call.init));
        issued.push(...((await answer.clone().json()).files ?? []));
        return answer;
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, ...options });
  return {
    db,
    locks,
    issued,
    fixture,
    client,
    /** How many files were hashed for a fingerprint. */
    hashedFiles: () => hashedFiles,
    /** The requests sent from now on. */
    from() {
      const start = fixture.requests.length;
      return () => fixture.requests.slice(start);
    },
    /** Resolves once every hash computed so far has settled and the store has gone quiet after it. */
    async drained() {
      for (let seen = -1; seen !== hashes.length; ) {
        seen = hashes.length;
        await Promise.allSettled(hashes);
        await db.settled();
      }
    },
  };
}
