// The browser's store of unfinished multipart uploads, so that one can resume after a reload (resume spec §3.1, §3.2;
// plan rulings R1–R3). An upload only queues writes here: it never waits for the store or fails on it. Reads report a
// failure as STORAGE_ERROR, never with the browser's own text.

import { fail, ok, type Result } from "../errors.ts";
import { countParts } from "../part-size.ts";
import { storageUnavailable } from "./failures.ts";

/** One multipart upload as IndexedDB keeps it: never a presigned URL, an ETag or a part list (spec §3.1). */
export interface UploadRecord {
  id: string;
  namespace: string;
  route: string;
  /** As sent to /upload. */
  metadata: unknown;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  fingerprint: string;
  token: string;
  key: string;
  partSize: number;
  partCount: number;
  expiresAt: string;
  /** Milliseconds since the epoch, for newest first. */
  savedAt: number;
}

export interface Records {
  /** False when persistence is off or the runtime has no indexedDB: then nothing is read or written (spec §3.7). */
  readonly enabled: boolean;
  /**
   * Queued in its place when called, also when the record is still being made (its fingerprint is read from the file):
   * a remove called after it runs after it. Never rejects; a failure, or a record that could not be made (a rejection),
   * is dropped: an upload never waits for or fails on the store.
   */
  save(record: UploadRecord | Promise<UploadRecord>): void;
  remove(id: string): void;
  /** The namespace's unexpired records, newest first (`savedAt` descending); expired ones are removed. */
  list(namespace: string): Promise<Result<UploadRecord[]>>;
  /** Deletes the namespace's records, or every record when `namespace` is null; resolves the count. */
  clear(namespace: string | null): Promise<Result<number>>;
}

const STORE = "uploads";

/** A record with less time left than this counts as expired, so a listed upload has time to start (R3, spec §3.6). */
const EXPIRY_MARGIN_MS = 60_000;

const noRecords: Records = {
  enabled: false,
  save: () => undefined,
  remove: () => undefined,
  list: async () => ok([]),
  clear: async () => ok(0),
};

/** Database `cloudrop`, version 1, store `uploads` keyed by `id`, no index (R1). */
function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open("cloudrop", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The type of each field of a record, checked on every record read: the database is shared with every script and
 * library version of the origin (M3-U80).
 */
const SHAPE = {
  id: "string",
  namespace: "string",
  route: "string",
  name: "string",
  size: "number",
  type: "string",
  lastModified: "number",
  fingerprint: "string",
  token: "string",
  key: "string",
  partSize: "number",
  partCount: "number",
  expiresAt: "string",
  savedAt: "number",
};

const isRecord = (value: unknown): value is UploadRecord =>
  typeof value === "object" &&
  value !== null &&
  Object.entries(SHAPE).every(([field, type]) => typeof (value as Record<string, unknown>)[field] === type);

type Work<T> = (store: IDBObjectStore, settle: (value: T) => void) => void;

/** Runs `work` in one transaction; resolves with the value it settled once the transaction commits. */
function transact<T>(database: IDBDatabase, work: Work<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    let value: T;
    transaction.oncomplete = () => resolve(value);
    // A failed request aborts its transaction, and so does a failed commit (a full disk).
    transaction.onabort = () => reject(transaction.error);
    work(transaction.objectStore(STORE), (settled) => {
      value = settled;
    });
  });
}

const onResult = <T>(request: IDBRequest<T>, use: (result: T) => void): void => {
  request.onsuccess = () => use(request.result);
};

/** A store over globalThis.indexedDB; a no-op one (lists [], counts 0) when `enabled` is false or there is none. */
export function createRecords(enabled: boolean, now: () => number = () => Date.now()): Records {
  const factory: IDBFactory | undefined = enabled ? globalThis.indexedDB : undefined;
  if (factory == null) return noRecords;

  // Opened on the first operation and kept. A failed open, or a connection the browser closed (site data cleared, a
  // newer schema in another tab), is opened again by the next operation, so one bad moment does not end resuming for
  // the page's life (R2).
  let database: Promise<IDBDatabase> | undefined;
  const connect = (): Promise<IDBDatabase> => {
    const drop = () => {
      if (database === opening) database = undefined;
    };
    const opening = open(factory).then((connection) => {
      connection.onclose = drop;
      connection.onversionchange = () => {
        connection.close();
        drop();
      };
      return connection;
    });
    opening.catch(drop);
    return opening;
  };
  // Every operation runs after the one made before it, so a remove made after a save never runs first (R2).
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: Work<T> | Promise<Work<T>>): Promise<Result<T>> => {
    const done = queue.then(async () => {
      const ready = await work;
      database ??= connect();
      const connection = await database;
      try {
        return ok(await transact(connection, ready));
      } catch (error) {
        // transaction() throws InvalidStateError on a connection that closed without telling us: open a new one next.
        if (error instanceof DOMException && error.name === "InvalidStateError") database = undefined;
        throw error;
      }
    });
    const result = done.catch(() => fail(storageUnavailable()));
    queue = result;
    return result;
  };

  /**
   * Whether `value`, stored under `id`, is a record this client can use. One that expired, has another shape, or a
   * part count its size and part size do not give (as answers.ts checks a live ticket, audit M2), is deleted. NaN, from
   * an expiresAt that is not a date, compares false: such a record counts as expired.
   */
  const usable = (store: IDBObjectStore, id: IDBValidKey, value: unknown): value is UploadRecord => {
    if (
      isRecord(value) &&
      value.partCount === countParts(value.size, value.partSize) &&
      Date.parse(value.expiresAt) - now() >= EXPIRY_MARGIN_MS
    ) {
      return true;
    }
    if (value !== undefined) store.delete(id);
    return false;
  };

  return {
    enabled: true,
    save(pending) {
      const work = Promise.resolve(pending).then((record) => (store: IDBObjectStore) => {
        store.put(record);
        // Expired records of any namespace are dropped too: their tokens no longer work (spec §3.2).
        onResult(store.getAll(), (all: UploadRecord[]) => {
          for (const stale of all) usable(store, stale.id, stale);
        });
      });
      // Handled at once: a record that fails while earlier operations still run is no unhandled rejection.
      work.catch(() => undefined);
      void enqueue(work);
    },
    remove(id) {
      void enqueue((store) => store.delete(id));
    },
    list: (namespace) =>
      enqueue((store, settle) =>
        onResult(store.getAll(), (all: UploadRecord[]) => {
          const live = all.filter((record) => usable(store, record.id, record) && record.namespace === namespace);
          settle(live.sort((a, b) => b.savedAt - a.savedAt));
        }),
      ),
    clear: (namespace) =>
      enqueue((store, settle) =>
        onResult(store.getAll(), (all: UploadRecord[]) => {
          const doomed = namespace === null ? all : all.filter((record) => record.namespace === namespace);
          for (const record of doomed) store.delete(record.id);
          settle(doomed.length);
        }),
      ),
  };
}
