// The record table of spec 1.0 §3b (M12-T1) as an oracle: what each status says about the row's times and result.
// `FileRecord` is a union by status that the stores only cast to, so this check on every row the contract reads is what
// proves the cast true on every backend.

import { expect } from "vitest";
import type { CloudropStore, FileRecordStatus } from "../../server/store.ts";
import type { RawTables } from "../store-rows.ts";

/** What the table constrains, loose on purpose: the oracle must be able to see a row the union calls impossible. */
interface RecordFields {
  id: string;
  status: FileRecordStatus;
  claimedAt: Date | null;
  completedAt: Date | null;
  endedAt: Date | null;
  cleanedAt: Date | null;
  result: string | null;
}

type Rule = "null" | "date" | "any";
type Field = "claimedAt" | "completedAt" | "endedAt" | "cleanedAt" | "result";

/** One row of the table per status; `result` is "any" where it may hold `onComplete`'s JSON or null. */
const TABLE: Record<FileRecordStatus, Record<Field, Rule>> = {
  pending: { claimedAt: "null", completedAt: "null", endedAt: "null", cleanedAt: "null", result: "null" },
  completing: { claimedAt: "date", completedAt: "null", endedAt: "null", cleanedAt: "null", result: "null" },
  completed: { claimedAt: "date", completedAt: "date", endedAt: "null", cleanedAt: "null", result: "any" },
  deleted: { claimedAt: "date", completedAt: "date", endedAt: "date", cleanedAt: "any", result: "any" },
  aborted: { claimedAt: "null", completedAt: "null", endedAt: "date", cleanedAt: "any", result: "null" },
  expired: { claimedAt: "null", completedAt: "null", endedAt: "date", cleanedAt: "any", result: "null" },
  rejected: { claimedAt: "date", completedAt: "null", endedAt: "date", cleanedAt: "any", result: "null" },
  // Two rows of the table: never started (claimedAt null), or a stuck completion, which the sweep ends cleaned.
  failed: { claimedAt: "any", completedAt: "null", endedAt: "date", cleanedAt: "any", result: "null" },
};

function breaks(rule: Rule, value: Date | string | null): string | null {
  if (rule === "null" && value !== null) return "with";
  if (rule === "date" && !(value instanceof Date)) return "without";
  return null;
}

/** Every way `record` breaks the table, each named, such as "f-1: completed without completedAt". */
function wellFormedProblems(record: RecordFields): string[] {
  const rules = TABLE[record.status];
  if (!rules) return [`${record.id}: unknown status ${JSON.stringify(record.status)}`];
  const problems = (Object.keys(rules) as Field[]).flatMap((field) => {
    const how = breaks(rules[field], record[field]);
    return how ? [`${record.id}: ${record.status} ${how} ${field}`] : [];
  });
  if (record.status === "failed" && record.claimedAt !== null && record.cleanedAt === null) {
    problems.push(`${record.id}: failed after a claim without cleanedAt`);
  }
  return problems;
}

export function expectWellFormed(...records: readonly RecordFields[]): void {
  expect(records.flatMap(wellFormedProblems)).toEqual([]);
}

type Store = Required<CloudropStore<unknown>>;
type Answer<K extends keyof Store> = Store[K] extends (...args: never[]) => Promise<infer T> ? T : never;

/** Answers of the store's methods that return records, each checked before a case sees it. */
type Checks = { [K in keyof Store]?: (answer: Answer<K>) => void };

const CHECKS: Checks = {
  get: (record) => record && expectWellFormed(record),
  claim: (outcome) => "record" in outcome && expectWellFormed(outcome.record),
  complete: ({ record, replaced }) => expectWellFormed(...(record ? [record] : []), ...replaced),
  end: ({ record }) => record && expectWellFormed(record),
  stale: ({ records }) => expectWellFormed(...records),
  list: ({ records }) => expectWellFormed(...records),
  listAll: ({ records }) => expectWellFormed(...records),
};

/**
 * `store` with every record it answers checked against the table, also inside a transaction. A Proxy, not a spread, so
 * a store whose methods live on its class and read `this` keeps working.
 */
export function checkedStore<TTx>(store: CloudropStore<TTx>): CloudropStore<TTx> {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "transaction") {
        return (run: (tx: TTx, inner: CloudropStore<TTx>) => Promise<unknown>) =>
          value.call(target, (tx: TTx, inner: CloudropStore<TTx>) => run(tx, checkedStore(inner)));
      }
      const check = CHECKS[property as keyof Checks] as ((answer: unknown) => void) | undefined;
      if (!check) return value.bind(target);
      return async (...args: unknown[]) => {
        const answer: unknown = await value.apply(target, args);
        check(answer);
        return answer;
      };
    },
  });
}

/** `raw` with every files row it reads checked against the table: rows no store method answered are covered too. */
export function checkedTables(raw: RawTables): RawTables {
  return {
    ...raw,
    files: async () => {
      const rows = await raw.files();
      expectWellFormed(...rows);
      return rows;
    },
  };
}
