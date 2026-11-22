// Setup shared by the unit tests of the server's store paths: a cloudrop server on the fake R2 with the memory store,
// a route whose rows carry an owner, and small tools to pause a callback and to record store calls. It builds inputs
// only; every expected value stays in the tests.

import type { CloudropOptions } from "../server/config.ts";
import { type Route, route } from "../server/route.ts";
import { type MemoryStore, memoryStore } from "./memory-store.ts";
import { type ServerFixture, serverFixture } from "./server-fixture.ts";

/** The time the clock is fixed at. */
export const NOW: Date = new Date("2026-11-17T12:00:00Z");
/** 24 hours after NOW: the deadline of a token signed at NOW. */
export const DEADLINE: Date = new Date("2026-11-18T12:00:00Z");

export const TEXT = { name: "hello.txt", size: 5, type: "text/plain" };
export const hello: Uint8Array<ArrayBuffer> = new TextEncoder().encode("hello");

/** Any file, owned by the signed-in user "u1". */
export const owned: Route<undefined, null> = route(
  { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
  { owner: ({ userId }) => userId },
);

type FixtureOptions = Omit<Partial<CloudropOptions<Record<string, Route>>>, "routes"> & { multipartThreshold?: number };

export interface StoreFixture extends ServerFixture {
  store: MemoryStore;
}

/** A server on the fake R2 whose store is `options.store`, or a new memory store. */
export function storeFixture(
  routes: Record<string, Route>,
  options: FixtureOptions & { store?: MemoryStore | Omit<MemoryStore, "transaction"> } = {},
): StoreFixture {
  const store = (options.store ?? memoryStore()) as MemoryStore;
  return { ...serverFixture(routes, { ...options, store }), store };
}

/** The memory store without `transaction`: the lease mode every store without one runs in. */
export function leaseStore(store: MemoryStore = memoryStore()): Omit<MemoryStore, "transaction"> {
  const { transaction: _transaction, ...rest } = store;
  return rest;
}

/** The store with each method call recorded by name, before it runs. A spread copy, so it keeps the store's code. */
export function recordCalls<TStore extends object>(store: TStore): { store: TStore; calls: string[] } {
  const calls: string[] = [];
  const recorded = {
    ...store,
    ...Object.fromEntries(
      Object.entries(store).map(([name, value]) => [
        name,
        typeof value === "function"
          ? (...args: unknown[]) => {
              calls.push(name);
              return value(...args);
            }
          : value,
      ]),
    ),
  };
  return { store: recorded as TStore, calls };
}

/** A point a callback stops at: `pass()` resolves once the test calls `open()`; `arrived` once a caller is waiting. */
export function gate(): { arrived: Promise<void>; open(): void; pass(): Promise<void> } {
  let open = () => {};
  let arrive = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    arrived,
    open: () => open(),
    pass: () => {
      arrive();
      return opened;
    },
  };
}
