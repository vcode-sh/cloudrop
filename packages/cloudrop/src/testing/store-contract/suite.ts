// What every group of store contract cases shares: the backend under test, fixed times, file builders and the steps
// that bring a row to a given status through the store's own methods.

import type { TestContext } from "vitest";
import type { CloudropStore, EndedStatus, FileStatus, NewFile } from "../../server/store.ts";
import type { StoreGap, StoreTarget } from "../store-contract.ts";
import type { RawFileRow, RawTables, RawUsageRow } from "../store-rows.ts";

export const MINUTE = 60_000;
/** The lease every case claims with: 5 minutes, the server's default. */
export const LEASE = 5 * MINUTE;
const T0 = Date.parse("2026-11-17T12:00:00.000Z");

/** The case's clock: `at(0)` is its start, `at(MINUTE)` one minute later. A fresh Date on every call. */
export const at = (ms: number): Date => new Date(T0 + ms);

/** The token deadline every reserved file gets unless a case sets another: a day after the start. */
export const EXPIRES: Date = at(24 * 60 * MINUTE);

export function newFile(id: string, size: number): NewFile {
  return { id, route: "avatars", key: `users/${id}.png`, name: `${id}.png`, type: "image/png", size, metadata: null };
}

/** The row `reserve` writes for `file` at `at(0)`, with `changes` on top: the expected value cases compare against. */
export function pendingRow(file: NewFile, owner: string | null, changes: Partial<RawFileRow> = {}): RawFileRow {
  return {
    ...file,
    owner,
    status: "pending",
    uploadId: null,
    result: null,
    claim: null,
    claimedAt: null,
    expiresAt: EXPIRES,
    createdAt: at(0),
    updatedAt: at(0),
    completedAt: null,
    endedAt: null,
    cleanedAt: null,
    requestKey: null,
    ...changes,
  };
}

export function usageRow(owner: string, counts: Partial<RawUsageRow>): RawUsageRow {
  return { owner, reservedBytes: 0, activeBytes: 0, files: 0, updatedAt: at(0), ...counts };
}

/** A member a target must provide unless it declares the matching gap; one that does neither fails here, loudly. */
export function provided<T>(value: T | undefined, member: string): T {
  if (value === undefined) {
    throw new Error(`The store target has no ${member}. Provide it, or declare its gap with the reason.`);
  }
  return value;
}

/** The statuses a pending row passes through to reach each status, the way the server moves it. */
const PATHS: Record<FileStatus, ("completing" | "completed" | EndedStatus)[]> = {
  pending: [],
  completing: ["completing"],
  completed: ["completing", "completed"],
  deleted: ["completing", "completed", "deleted"],
  aborted: ["aborted"],
  rejected: ["rejected"],
  failed: ["failed"],
  expired: ["expired"],
};

/** The backend as the cases see it; read inside a case, after setup. */
export interface StoreSuite {
  readonly target: StoreTarget;
  readonly store: CloudropStore<unknown>;
  readonly raw: RawTables;
  skipWithout(ctx: TestContext, gap: StoreGap): void;
  /** Skips without "failureInjection", otherwise arms the target's one-shot usage-write failure. */
  failNextUsageWrite(ctx: TestContext): Promise<void>;
  /** One files row, read past the store. */
  rawFile(id: string): Promise<RawFileRow | undefined>;
  /** Reserves `files` for `owner` at `at(0)` without a limit; throws unless every one is reserved. */
  seed(owner: string | null, files: readonly NewFile[], expiresAt?: Date): Promise<void>;
  /** Brings a reserved row to `status` through the store at `now`, the way the server does. */
  advance(id: string, status: FileStatus, now: Date): Promise<void>;
}

export function storeSuite(connected: () => StoreTarget): StoreSuite {
  const store = (): CloudropStore<unknown> => connected().store;

  function skipWithout(ctx: TestContext, gap: StoreGap): void {
    const reason = connected().gaps[gap];
    ctx.skip(reason !== undefined, reason);
  }

  /** One step of `advance`: true when the store made it. */
  async function step(
    id: string,
    from: FileStatus,
    to: "completing" | "completed" | EndedStatus,
    now: Date,
  ): Promise<boolean> {
    const claim = `claim-${id}`;
    if (to === "completing") return (await store().claim(id, claim, now, LEASE)).kind === "claimed";
    if (to === "completed") return (await store().complete(id, claim, null, now)).changed;
    return (await store().end(id, from, to, now)).changed;
  }

  async function advance(id: string, status: FileStatus, now: Date): Promise<void> {
    let from: FileStatus = "pending";
    for (const to of PATHS[status]) {
      if (!(await step(id, from, to, now))) throw new Error(`Could not bring ${id} from ${from} to ${to}.`);
      from = to;
    }
  }

  return {
    get target() {
      return connected();
    },
    get store() {
      return store();
    },
    get raw() {
      return connected().raw;
    },
    skipWithout,
    async failNextUsageWrite(ctx) {
      skipWithout(ctx, "failureInjection");
      await provided(connected().injectFailure, "injectFailure")();
    },
    async rawFile(id) {
      return (await connected().raw.files()).find((row) => row.id === id);
    },
    async seed(owner, files, expiresAt = EXPIRES) {
      const outcomes = await store().reserve({ owner, limit: null, expiresAt, requestKey: null, files }, at(0));
      if (outcomes.some((outcome) => outcome !== "reserved")) throw new Error(`Seeding failed: ${outcomes.join(", ")}`);
    },
    advance,
  };
}
