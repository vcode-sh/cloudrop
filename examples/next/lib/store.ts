import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteExecutor, sqlStore } from "cloudrop/adapters/sql";

/**
 * The example's opt-in database store (docs/guide/store.md). CLOUDROP_EXAMPLE_STORE=sqlite keeps it in
 * .data/cloudrop.db; any other value is the database file's path. Unset, the example stays stateless.
 */
function openDatabase(setting: string | undefined): DatabaseSync | null {
  if (!setting) return null;
  const path = setting === "sqlite" ? join(".data", "cloudrop.db") : setting;
  mkdirSync(dirname(path), { recursive: true });
  // A busy timeout, because `next build` and `next start` may open the file at once and SQLite allows one writer.
  const database = new DatabaseSync(path, { timeout: 5000 });
  // `next start` runs in examples/next, where the DDL file is.
  database.exec(readFileSync(join(process.cwd(), "lib", "cloudrop-tables.sql"), "utf8"));
  // The app's own table, which onComplete writes: what a real app records about a finished upload.
  database.exec(`CREATE TABLE IF NOT EXISTS example_uploads (
    id TEXT NOT NULL PRIMARY KEY,
    owner TEXT NOT NULL,
    key TEXT NOT NULL,
    size INTEGER NOT NULL,
    completions INTEGER NOT NULL
  )`);
  return database;
}

const database = openDatabase(process.env.CLOUDROP_EXAMPLE_STORE);

/** The store for createCloudrop, or null when the example is stateless. */
export const store = database ? sqlStore(sqliteExecutor(database)) : null;

/** Bytes each user may keep: CLOUDROP_EXAMPLE_QUOTA_MB, 500 MB unless set (1 MB = 1024 * 1024 bytes, as in maxSize). */
export const quotaBytes = Number(process.env.CLOUDROP_EXAMPLE_QUOTA_MB ?? 500) * 1024 * 1024;

export interface RecordedUpload {
  key: string;
  size: number;
  /** How many times onComplete ran for the file: 1, unless a server stopped between onComplete and its record. */
  completions: number;
}

/**
 * Records a finished upload in the app's table. Without a transaction, onComplete runs again only after a crash or a
 * timeout between it and the completion's record, so the write is idempotent: a second run counts, never duplicates.
 */
export function recordUpload(owner: string, file: { id: string; key: string; size: number }): void {
  database
    ?.prepare(
      `INSERT INTO example_uploads (id, owner, key, size, completions) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (id) DO UPDATE SET completions = completions + 1`,
    )
    .run(file.id, owner, file.key, file.size);
}

/** The user's finished uploads, by key. */
export function uploadsOf(owner: string): RecordedUpload[] {
  const rows = database
    ?.prepare("SELECT key, size, completions FROM example_uploads WHERE owner = ? ORDER BY key")
    .all(owner);
  return (rows ?? []).map((row) => ({
    key: String(row.key),
    size: Number(row.size),
    completions: Number(row.completions),
  }));
}
