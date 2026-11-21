// The texts of an /upload request on a real Postgres (M11-R196): its text columns cannot hold U+0000, so a file name
// with one must be refused before the reserve, for that file alone. Before, the whole reserve failed and every file
// of the request was answered a retryable SERVER_ERROR, on every retry. Everything else a request may carry is stored.

import { beforeEach, expect, test } from "vitest";
import { pgExecutor, sqlStore } from "../adapters/sql.ts";
import type { FileTicket } from "../protocol/types.ts";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { upload } from "../testing/upload-fixture.ts";
import { route } from "./route.ts";
import type { StandardSchema } from "./schema.ts";

const db = usePostgresDatabase();
beforeEach(async () => {
  await db.reset();
  await db.createTables();
});

const anything: StandardSchema<unknown> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
};
const docs = route(
  { accept: "*/*", maxSize: "1GB", metadata: anything, authorize: () => ({ userId: "u1" }) },
  { owner: ({ userId }) => userId },
);

test("a name with NUL is refused for its file alone, and Postgres stores the request's other texts", async () => {
  const fixture = serverFixture({ docs }, { store: sqlStore(pgExecutor(db.pool)) });
  const file = (name: string) => ({ name, size: 1, type: "text/plain" });
  const { status, body } = await upload(fixture, {
    route: "docs",
    files: [file("a\u0000b.txt"), file("Icon\r"), file("plain.txt")],
    metadata: { "key\u0000": "value\u0000\ud800\r\n" },
  });

  expect(status).toBe(200);
  expect(body.files.map((ticket: FileTicket) => (ticket.kind === "rejected" ? ticket.error : ticket.kind))).toEqual([
    {
      code: "INVALID_INPUT",
      message:
        "This file's name has a NUL character (U+0000), which cannot be stored. Rename the file, then add it again.",
      retryable: false,
    },
    "single",
    "single",
  ]);
  expect(await db.query("SELECT name, status, metadata FROM cloudrop_files ORDER BY name")).toEqual([
    { name: "Icon\r", status: "pending", metadata: '{"key\\u0000":"value\\u0000\\ud800\\r\\n"}' },
    { name: "plain.txt", status: "pending", metadata: '{"key\\u0000":"value\\u0000\\ud800\\r\\n"}' },
  ]);
});
