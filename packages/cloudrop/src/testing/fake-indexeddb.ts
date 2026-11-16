// A fake of the IndexedDB subset client/records.ts uses, for its unit tests: `indexedDB.open` with an upgrade on first
// open, readonly and readwrite transactions on object stores with string keys, and `put`, `get`, `getAll` and `delete`.
// As in a browser, events fire later (in microtasks), values are structured-cloned when written and when read,
// `getAll` returns values in key order, and a transaction completes after its last request or aborts after a failed
// one, rolling back its writes. Version changes, indexes, cursors and the requests left pending by an abort are not
// modelled. It is never shipped.

export interface FakeIndexedDb {
  /** For vi.stubGlobal("indexedDB", fake.indexedDB). */
  indexedDB: { open(name: string, version: number): unknown };
  /** The records stored in R1's database `cloudrop`, store `uploads`, by key, as a structured clone keeps them. */
  stored(): Record<string, unknown>;
  /** Makes the next n requests (an open or any store request) fail with this DOMException name. */
  failNext(name: "QuotaExceededError" | "UnknownError" | "InvalidStateError", n?: number): void;
}

type Handler = (() => void) | null;
type Rows = Map<string, unknown>;
interface Store {
  keyPath: string;
  rows: Rows;
}

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  readonly #name: string;
  readonly #store: Store;
  readonly #writable: boolean;
  readonly #nextFailure: () => DOMException | null;
  readonly #before: Rows;
  #pending = 0;
  #finished = false;

  constructor(name: string, store: Store, mode: string, nextFailure: () => DOMException | null) {
    this.#name = name;
    this.#store = store;
    this.#writable = mode === "readwrite";
    this.#nextFailure = nextFailure;
    this.#before = new Map(store.rows);
    // A transaction that makes no request completes too.
    queueMicrotask(() => this.#completeIfIdle());
  }

  objectStore(name: string) {
    if (name !== this.#name) throw new DOMException(`No object store "${name}" in this transaction.`, "NotFoundError");
    const { keyPath, rows } = this.#store;
    return {
      put: (value: unknown) => {
        // Cloned now, as a browser does: a later change to `value` is not stored, and an uncloneable value throws here.
        const copy = structuredClone(value) as Record<string, unknown>;
        return this.#request(true, () => {
          rows.set(String(copy[keyPath]), copy);
          return copy[keyPath];
        });
      },
      get: (key: string) => this.#request(false, () => structuredClone(rows.get(key))),
      getAll: () => this.#request(false, () => [...rows.keys()].sort().map((key) => structuredClone(rows.get(key)))),
      delete: (key: string) => this.#request(true, () => void rows.delete(key)),
    };
  }

  #request(writes: boolean, run: () => unknown): FakeRequest {
    if (this.#finished) throw new DOMException("The transaction has finished.", "TransactionInactiveError");
    if (writes && !this.#writable) throw new DOMException("The transaction is read-only.", "ReadOnlyError");
    const request = new FakeRequest();
    this.#pending += 1;
    queueMicrotask(() => {
      this.#pending -= 1;
      if (this.#finished) return;
      const failure = this.#nextFailure();
      if (failure !== null) {
        request.error = failure;
        request.onerror?.();
        this.#abort(failure);
        return;
      }
      request.result = run();
      request.onsuccess?.();
      this.#completeIfIdle();
    });
    return request;
  }

  #completeIfIdle(): void {
    if (this.#pending > 0 || this.#finished) return;
    this.#finished = true;
    queueMicrotask(() => this.oncomplete?.());
  }

  #abort(error: DOMException): void {
    this.#finished = true;
    this.error = error;
    this.#store.rows.clear();
    for (const [key, value] of this.#before) this.#store.rows.set(key, value);
    queueMicrotask(() => {
      this.onerror?.();
      this.onabort?.();
    });
  }
}

export function fakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, Map<string, Store>>();
  const failures: string[] = [];
  const nextFailure = (): DOMException | null => {
    const name = failures.shift();
    return name === undefined ? null : new DOMException(`The fake database failed this request (${name}).`, name);
  };

  /** A connection to `stores`; `createObjectStore` works only while `upgrading()` holds, as in onupgradeneeded. */
  const connect = (stores: Map<string, Store>, upgrading: () => boolean) => ({
    createObjectStore(name: string, options: { keyPath: string }): void {
      if (!upgrading()) throw new DOMException("Not in an upgrade.", "InvalidStateError");
      stores.set(name, { keyPath: options.keyPath, rows: new Map() });
    },
    transaction(name: string, mode = "readonly"): FakeTransaction {
      const store = stores.get(name);
      if (store === undefined) throw new DOMException(`No object store "${name}".`, "NotFoundError");
      return new FakeTransaction(name, store, mode, nextFailure);
    },
  });

  const indexedDB = {
    open(name: string, _version: number): FakeRequest {
      const request = new FakeRequest();
      queueMicrotask(() => {
        const failure = nextFailure();
        if (failure !== null) {
          request.error = failure;
          request.onerror?.();
          return;
        }
        let stores = databases.get(name);
        let upgrading = stores === undefined;
        stores ??= new Map();
        databases.set(name, stores);
        request.result = connect(stores, () => upgrading);
        if (upgrading) request.onupgradeneeded?.();
        upgrading = false;
        request.onsuccess?.();
      });
      return request;
    },
  };

  return {
    indexedDB,
    stored: () => {
      const rows = databases.get("cloudrop")?.get("uploads")?.rows ?? new Map();
      return Object.fromEntries([...rows].map(([key, value]) => [key, structuredClone(value)]));
    },
    failNext(name, n = 1) {
      for (let i = 0; i < n; i += 1) failures.push(name);
    },
  };
}
