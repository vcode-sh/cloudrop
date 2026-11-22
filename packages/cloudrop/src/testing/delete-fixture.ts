// Setup shared by the onDelete unit tests: a server whose "files" route records each onDelete call, on a store with a
// transaction or under a lease. It builds inputs only; every expected value stays in the tests.

import type { SingleTicket } from "../protocol/types.ts";
import type { DeleteContext } from "../server/delete-context.ts";
import { route, routeFor } from "../server/route.ts";
import type { CloudropStore, FileRecordStatus } from "../server/store.ts";
import { complete } from "./complete-fixture.ts";
import { type MemoryStore, type MemoryTx, memoryStore } from "./memory-store.ts";
import { hello, leaseStore, type StoreFixture, storeFixture, TEXT } from "./store-fixture.ts";

export type Mode = "transaction" | "lease";
export const MODES: Mode[] = ["transaction", "lease"];

/** One onDelete call as the hook saw it. */
export interface Seen {
  id: string;
  owner: string | null;
  reason: string;
  status: string;
  tx: boolean;
  /** What the caller passed as context. */
  context?: unknown;
  /** Whether it got the replacing upload's request. */
  request: boolean;
}

interface DeletingOptions {
  replace?: boolean;
  /** A store whose methods live on its prototype and whose transaction reads `this`, as a class's would. */
  inherited?: boolean;
  /** A plain `route()`, which gets no `tx`, also on a store with a transaction. */
  plain?: boolean;
  /** What onDelete returns for a call, after its write through `tx`: a CloudropError refuses the deletion. */
  answer?: (context: DeleteContext) => unknown;
  /** Gives the route an onComplete. */
  completing?: boolean;
}

export interface Deleting {
  fixture: StoreFixture;
  memory: MemoryStore;
  /** Every onDelete call, in order. */
  seen: Seen[];
  /** The files onComplete ran for, in order. */
  completions: string[];
  state: {
    failing: boolean;
    unique: boolean;
    pause: (() => Promise<void>) | undefined;
    /** Stops the next read of a file's row, after the store answered it, until the test opens it. */
    read: (() => Promise<void>) | undefined;
  };
  /** Uploads a file's bytes and leaves the upload uncompleted. */
  upload(): Promise<SingleTicket>;
  /** Uploads a file and completes it. */
  uploaded(): Promise<SingleTicket>;
  status(id: string): Promise<FileRecordStatus | undefined>;
  /** Whether the bucket holds an object at the key. */
  stored(key: string): Promise<boolean>;
}

/**
 * A server whose "files" route (one file per owner with `replace`) records each onDelete call, writes an app row through
 * `tx` when it has one, and throws while `failing` is set, or with `unique` for a file it already ran for (as an
 * audit insert keyed by the file would). `pause` stops the next call until the test opens it, and `read` the store's
 * next `get`, in a transaction or outside one, so what its caller read can go stale. With `completing`, its onComplete
 * writes an app row through `tx` too, and `completions` lists the files it ran for.
 */
export function deleting(mode: Mode, options: DeletingOptions = {}): Deleting {
  const state: Deleting["state"] = { failing: false, unique: false, pause: undefined, read: undefined };
  /** `get`, stopped once after the store answered it while `state.read` is set. */
  function held(get: MemoryStore["get"]): MemoryStore["get"] {
    return async (id) => {
      const row = await get(id);
      const read = state.read;
      state.read = undefined;
      await read?.();
      return row;
    };
  }
  const base = memoryStore();
  const memory: MemoryStore = {
    ...base,
    get: held(base.get),
    transaction: <T>(run: (tx: MemoryTx, store: Omit<CloudropStore<MemoryTx>, "transaction">) => Promise<T>) =>
      base.transaction((tx, scoped) => run(tx, { ...scoped, get: held(scoped.get) })),
  };
  const backing: MemoryStore = options.inherited
    ? Object.create(memory, {
        transaction: {
          value(this: unknown, run: Parameters<MemoryStore["transaction"]>[0]) {
            if (this !== backing) throw new TypeError("Cannot read private member #pool from an object");
            return memory.transaction(run);
          },
        },
      })
    : memory;
  const seen: Seen[] = [];
  const completions: string[] = [];
  const onDelete = async (context: DeleteContext & { tx?: MemoryTx }) => {
    const { file, owner, reason, tx, request } = context;
    const pause = state.pause;
    state.pause = undefined;
    await pause?.();
    const again = seen.some((call) => call.id === file.id);
    seen.push({
      id: file.id,
      owner,
      reason,
      status: file.status,
      tx: tx !== undefined,
      context: context.context,
      request: !!request,
    });
    tx?.write(`${reason} ${file.id}`);
    if (state.failing) throw new Error("The audit table is down.");
    if (state.unique && again) throw new Error("duplicate key value violates unique constraint");
    return options.answer?.(context);
  };
  const onComplete = ({ file, tx }: { file: { id: string }; tx?: MemoryTx }) => {
    completions.push(file.id);
    tx?.write(`completed ${file.id}`);
  };
  const policy = { accept: "*/*", maxSize: 1024, replace: options.replace, authorize: () => ({ userId: "u1" }) };
  // The hook's result is typed by each test's `answer`, which may be a value no hook is allowed to return.
  const callbacks = {
    owner: ({ userId }: { userId: string }) => userId,
    ...(options.completing ? { onComplete } : {}),
    onDelete: onDelete as never,
  };
  const files =
    mode === "transaction" && !options.plain
      ? routeFor<{ tx: MemoryTx }>(backing)(policy, callbacks)
      : route(policy, callbacks);
  const fixture = storeFixture({ files }, { store: mode === "transaction" ? backing : leaseStore(memory) });
  const upload = async () => {
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    return ticket;
  };
  const uploaded = async () => {
    const ticket = await upload();
    const { status } = await complete(fixture, ticket.token);
    if (status !== 200) throw new Error(`The upload did not complete: /complete answered ${status}.`);
    return ticket;
  };
  const status = async (id: string) => (await fixture.cloudrop.api.file(id)).data?.status;
  const stored = async (key: string) => (await fixture.storage.head(key)).data !== null;
  return { fixture, memory, seen, completions, state, upload, uploaded, status, stored };
}
