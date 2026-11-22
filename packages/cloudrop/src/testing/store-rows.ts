// The rows of a store's two tables as a test reads them straight from the backend, past the store: the contract suite's
// oracle. Every backend's reader returns this one shape, whatever the database keeps (snake_case columns, int8 as
// strings, times as integer milliseconds on SQLite).

import type { FileRecordStatus, OwnerUsage } from "../server/store.ts";

/** A `cloudrop_files` row: every column, camelCased, sizes as numbers and times as `Date`s. */
export interface RawFileRow {
  id: string;
  route: string;
  key: string;
  owner: string | null;
  status: FileRecordStatus;
  name: string;
  type: string;
  size: number;
  uploadId: string | null;
  metadata: string | null;
  result: string | null;
  claim: string | null;
  claimedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  endedAt: Date | null;
  cleanedAt: Date | null;
  /** The idempotency key of the `/upload` that wrote the row, or null. */
  requestKey: string | null;
}

/** A `cloudrop_usage` row. */
export interface RawUsageRow extends OwnerUsage {
  owner: string;
  updatedAt: Date;
}

/** Reads (and, to simulate drift, writes) a backend's tables directly. */
export interface RawTables {
  /** Every files row, ordered by id. */
  files(): Promise<RawFileRow[]>;
  /** Every usage row, ordered by owner. */
  usage(): Promise<RawUsageRow[]>;
  /** Inserts or replaces one usage row, bypassing the store: how a test makes the counters drift. */
  putUsage(row: RawUsageRow): Promise<void>;
  /** Deletes one owner's usage row, bypassing the store: how a test leaves rows without counters. */
  deleteUsage(owner: string): Promise<void>;
}
