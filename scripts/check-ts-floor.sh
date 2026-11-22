#!/usr/bin/env bash
# The TypeScript floor (M12-P3, M12-P5): the packed tarball, installed into a fresh project as an app installs it,
# type-checks with TypeScript 7.0.2 exactly, the oldest release of the 7.0 floor (npm has no 7.0.0 or 7.0.1: 7.0.1-rc
# came first, then 7.0.2), with skipLibCheck off so the compiler reads cloudrop's own .d.ts. The consumer below imports every entry and uses createCloudrop, route,
# createCloudropClient, createUploadHooks, sqlStore and defineStore; its expect-error lines prove the types are not
# `any`. Run after `bun run build`.
#   CLOUDROP_TS_FLOOR_DIR=<empty directory outside the repository> scripts/check-ts-floor.sh
# The project must sit outside the repository: module resolution walks up, so inside it a package missing from the
# project would resolve from the workspace's node_modules and pass. CI uses $RUNNER_TEMP; the trap removes the project
# on success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$ROOT/packages/cloudrop"
TYPESCRIPT=7.0.2

if [[ -n "${CLOUDROP_TS_FLOOR_DIR:-}" ]]; then
  DEST="$CLOUDROP_TS_FLOOR_DIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
  DEST="$RUNNER_TEMP/ts-floor"
else
  echo "Set CLOUDROP_TS_FLOOR_DIR to a directory outside the repository, such as ../ts-floor." >&2
  exit 1
fi
DEST="$(realpath -m "$DEST")"
if [[ "$DEST/" == "$ROOT/"* ]]; then
  echo "$DEST is inside the repository, where the workspace's packages would resolve. Choose a path outside it." >&2
  exit 1
fi
if [[ -e "$DEST" ]]; then
  echo "$DEST already exists. Remove it, or set CLOUDROP_TS_FLOOR_DIR to a path that does not." >&2
  exit 1
fi
if [[ ! -f "$PACKAGE/dist/index.d.ts" ]]; then
  echo "No build in packages/cloudrop/dist. Run bun run build first." >&2
  exit 1
fi
# Registered before the project is made, so a failed install or check still removes it.
trap 'rm -rf "$DEST"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The peers the types import (react, drizzle-orm) at the versions the workspace tests with.
installed() { node -p "require('$PACKAGE/node_modules/$1/package.json').version"; }
mkdir -p "$DEST"
(cd "$PACKAGE" && bun pm pack --destination "$DEST" --quiet >/dev/null)
TARBALL="$(cd "$DEST" && ls cloudrop-*.tgz)"
cat >"$DEST/package.json" <<EOF
{ "name": "cloudrop-ts-floor", "private": true, "type": "module",
  "dependencies": { "cloudrop": "file:./$TARBALL", "@types/react": "$(installed @types/react)",
    "drizzle-orm": "$(installed drizzle-orm)", "typescript": "$TYPESCRIPT" } }
EOF
# Two programs. app.ts compiles every entry but the Drizzle adapter with skipLibCheck off, so cloudrop's own .d.ts are
# checked, @types/react's with them. drizzle.ts compiles the Drizzle adapter with skipLibCheck on: drizzle-orm's own
# .d.ts need @types/node and mysql2, which an app without them never loads, so with it off they fail on their own.
tsconfig() {
  cat >"$DEST/tsconfig.$1.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": [], "strict": true, "noEmit": true, "skipLibCheck": $2
  },
  "files": ["$1.ts"]
}
EOF
}
tsconfig app false
tsconfig drizzle true
cat >"$DEST/app.ts" <<'EOF'
import { allowAnyone, type CloudropErrorCode, createCloudrop, route } from "cloudrop";
import { prismaStore } from "cloudrop/adapters/prisma";
import { type SqliteDatabase, sqliteExecutor, sqlStore } from "cloudrop/adapters/sql";
import { createCloudropClient } from "cloudrop/client";
import { toNextHandler } from "cloudrop/next";
import { toNodeHandler } from "cloudrop/node";
import { contentChecks } from "cloudrop/plugins";
import { createUploadHooks } from "cloudrop/react";
import { type CloudropStore, defineStore } from "cloudrop/store";
import { memoryStore, testBucket } from "cloudrop/testing";

declare const db: SqliteDatabase;
declare const handWritten: CloudropStore;
const store = sqlStore(sqliteExecutor(db));
const avatar = route(
  { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1" }) },
  { owner: ({ userId }) => userId, onComplete: ({ file }) => ({ url: file.url }) },
);
export const cloudrop = createCloudrop({
  store,
  plugins: [contentChecks()],
  routes: { avatar, open: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }) },
});
export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
export const node = toNodeHandler(cloudrop);
export const stores = [defineStore(handWritten), memoryStore(), prismaStore, testBucket];

const client = createCloudropClient<typeof cloudrop>({ account: "u1" });
export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>();

export async function upload(file: File): Promise<string | null | CloudropErrorCode> {
  // @ts-expect-error: the server has no route of this name.
  client.start("nope", file);
  const uploaded = await client.upload("avatar", file);
  if (uploaded.error) return uploaded.error.code;
  const url: string | null = uploaded.data.data.url;
  const page = await cloudrop.api.files({ owner: "u1", route: "avatar" });
  // @ts-expect-error: a listed file is completed, so its completedAt is a Date, never null.
  const never: null | undefined = page.data?.items[0]?.completedAt;
  return never ?? url;
}
EOF
cat >"$DEST/drizzle.ts" <<'EOF'
import { createCloudrop } from "cloudrop";
import { cloudropPgTables, type DrizzlePostgres, drizzleStore } from "cloudrop/adapters/drizzle";

declare const db: DrizzlePostgres;
export const tables = cloudropPgTables();
const store = drizzleStore(db, { dialect: "postgres", transaction: true });
export const cloudrop = createCloudrop({
  store,
  routes: {
    avatar: store.route(
      { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId, onComplete: ({ tx }) => tx !== undefined },
    ),
  },
});
EOF
cd "$DEST"
# Types only: no install scripts.
bun install --ignore-scripts >/dev/null
echo "Type-checking the packed types with TypeScript $(node -p "require('typescript/package.json').version")"
./node_modules/.bin/tsc -p tsconfig.app.json
./node_modules/.bin/tsc -p tsconfig.drizzle.json
echo "The packed types of every entry type-check with TypeScript $TYPESCRIPT."
