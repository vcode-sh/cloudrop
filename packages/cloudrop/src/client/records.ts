// The browser's store of unfinished multipart uploads, so that one can resume after a reload (resume spec §3.1, §3.2;
// plan rulings R1–R3). An upload only queues writes here: it never waits for the store or fails on it. Reads report a
// failure as STORAGE_ERROR, never with the browser's own text.

import { fail, ok, type Result } from "../errors.ts";
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
  /** Queued; never rejects; a failure is dropped (an upload never waits for or fails on the store). */
  save(record: UploadRecord): void;
  remove(id: string): void;
  /** The namespace's record with this id, or null (also when it expired: then it is removed). */
  get(id: string, namespace: string): Promise<Result<UploadRecord | null>>;
  /** The namespace's unexpired records, newest first (`savedAt` descending); expired ones are removed. */
  list(namespace: string): Promise<Result<UploadRecord[]>>;
  /** Deletes the namespace's records, or every record when `namespace` is null; resolves the count. */
  clear(namespace: string | null): Promise<Result<number>>;
}

const STORE = "uploads";

/** A record with less time left than this counts as expired, so a listed upload has time to start (R3, spec §3.6). */
const EXPIRY_MARGIN_MS = 60_000;

const noRecords: Records = {
  save: () => undefined,
  remove: () => undefined,
  get: async () => ok(null),
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
    const opening = open(factory).then((connection) => {
      const drop = () => {
        if (database === opening) database = undefined;
      };
      connection.onclose = drop;
      connection.onversionchange = () => {
        connection.close();
        drop();
      };
      return connection;
    });
    opening.catch(() => {
      if (database === opening) database = undefined;
    });
    return opening;
  };
  // Every operation runs after the one made before it, so a remove made after a save never runs first (R2).
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: Work<T>): Promise<Result<T>> => {
    const done = queue.then(async () => {
      database ??= connect();
      const connection = await database;
      try {
        return ok(await transact(connection, work));
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

  // NaN, from an expiresAt that is not a date, compares false: such a record counts as expired.
  const isLive = (record: UploadRecord): boolean => Date.parse(record.expiresAt) - now() >= EXPIRY_MARGIN_MS;

  return {
    save(record) {
      void enqueue((store) => {
        store.put(record);
        // Expired records of any namespace are dropped too: their tokens no longer work (spec §3.2).
        onResult(store.getAll(), (all: UploadRecord[]) => {
          for (const stale of all) if (!isLive(stale)) store.delete(stale.id);
        });
      });
    },
    remove(id) {
      void enqueue((store) => store.delete(id));
    },
    get: (id, namespace) =>
      enqueue((store, settle) =>
        onResult(store.get(id), (record: UploadRecord | undefined) => {
          if (record?.namespace !== namespace) return settle(null);
          if (isLive(record)) return settle(record);
          store.delete(id);
          settle(null);
        }),
      ),
    list: (namespace) =>
      enqueue((store, settle) =>
        onResult(store.getAll(), (all: UploadRecord[]) => {
          const live: UploadRecord[] = [];
          for (const record of all) {
            if (record.namespace !== namespace) continue;
            if (isLive(record)) live.push(record);
            else store.delete(record.id);
          }
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
