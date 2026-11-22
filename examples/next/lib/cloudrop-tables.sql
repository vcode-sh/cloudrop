-- cloudrop's two tables on SQLite (docs/guide/store.md). IF NOT EXISTS, so the example can run it at every start.

CREATE TABLE IF NOT EXISTS "cloudrop_files" (
  id TEXT NOT NULL PRIMARY KEY,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  upload_id TEXT,
  metadata TEXT,
  result TEXT,
  claim TEXT,
  claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  ended_at INTEGER,
  cleaned_at INTEGER,
  request_key TEXT
);

CREATE INDEX IF NOT EXISTS "cloudrop_files_status_expires_at_idx" ON "cloudrop_files" (status, expires_at);

CREATE INDEX IF NOT EXISTS "cloudrop_files_status_claimed_at_idx" ON "cloudrop_files" (status, claimed_at);

CREATE INDEX IF NOT EXISTS "cloudrop_files_status_cleaned_at_ended_at_idx" ON "cloudrop_files" (status, cleaned_at, ended_at);

CREATE INDEX IF NOT EXISTS "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" (owner, status, created_at);

CREATE INDEX IF NOT EXISTS "cloudrop_files_created_at_idx" ON "cloudrop_files" (created_at);

CREATE INDEX IF NOT EXISTS "cloudrop_files_key_idx" ON "cloudrop_files" (key);

CREATE INDEX IF NOT EXISTS "cloudrop_files_route_request_key_idx" ON "cloudrop_files" (route, request_key);

CREATE TABLE IF NOT EXISTS "cloudrop_usage" (
  owner TEXT NOT NULL PRIMARY KEY,
  reserved_bytes INTEGER NOT NULL,
  active_bytes INTEGER NOT NULL,
  files INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  erase_requested_at INTEGER,
  erased_at INTEGER
);

CREATE INDEX IF NOT EXISTS "cloudrop_usage_erasing_idx" ON "cloudrop_usage" (owner) WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL;
