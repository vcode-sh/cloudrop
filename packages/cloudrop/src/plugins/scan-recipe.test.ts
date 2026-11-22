// The virus-scan recipe of docs/guide/plugins.md ("Scanning uploads"), run on the fake R2 with a store. The guide shows
// its import and the code of virusScan below, with "cloudrop" in place of "../index.ts" and `export` in front of the
// function (a test file exports nothing), and the last test fails when the two differ.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CloudropError, type CloudropPlugin } from "../index.ts";
import { complete } from "../testing/complete-fixture.ts";
import { owned, storeFixture } from "../testing/store-fixture.ts";

/** Refuses an infected file at /complete. `scan` is your scanning service: it reads the URL and gives its verdict. */
function virusScan(scan: (url: string) => Promise<{ infected: boolean }>): CloudropPlugin {
  return {
    id: "virus-scan",
    server: {
      async afterVerify({ file, storage }) {
        const link = await storage.presignGet(file.key, { expiresIn: 300 });
        if (link.error) throw link.error; // a throw keeps the object, and the client completes again
        const { infected } = await scan(link.data.url); // so does a scanner that is down: it fails closed
        if (!infected) return undefined;
        return new CloudropError("VERIFICATION_FAILED", "This file did not pass the virus scan. Pick another file.");
      },
    },
  };
}

// The EICAR test string, which every scanner reports as infected; here a stand-in scanner that looks for it.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** A server whose scanner reads each file through the URL the recipe signs, and records what it read. */
function scanned() {
  const reads: string[] = [];
  let down = false;
  const fixture = storeFixture(
    { owned },
    {
      plugins: [
        virusScan(async (url) => {
          if (down) throw new Error("scanner unreachable");
          const text = await (await fixture.fake.fetch(url)).text();
          reads.push(text);
          return { infected: text.includes(EICAR) };
        }),
      ],
    },
  );
  async function upload(text: string) {
    const bytes = new TextEncoder().encode(text);
    const ticket = await fixture.single("owned", { name: "notes.txt", size: bytes.length, type: "text/plain" });
    await fixture.send(ticket.put, bytes);
    return ticket;
  }
  const status = async (id: string) => (await fixture.cloudrop.api.file(id)).data?.status;
  return {
    fixture,
    reads,
    upload,
    status,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

test("an infected file is refused with VERIFICATION_FAILED, its object deleted and its row rejected", async () => {
  const { fixture, upload, status } = scanned();
  const ticket = await upload(EICAR);

  const { status: http, body } = await complete(fixture, ticket.token);

  expect([http, body.error?.code, body.error?.retryable]).toEqual([422, "VERIFICATION_FAILED", false]);
  expect(body.error?.message).toBe("This file did not pass the virus scan. Pick another file.");
  expect(fixture.fake.keys()).toEqual([]);
  expect(await status(ticket.id)).toBe("rejected");
});

test("a scanner that throws fails closed: a retryable 500, the object kept, and the next /complete scans again", async () => {
  const { fixture, upload, status, setDown } = scanned();
  const ticket = await upload("hello");
  setDown(true);

  const { status: http, body } = await complete(fixture, ticket.token);

  expect([http, body.error?.code, body.error?.retryable]).toEqual([500, "SERVER_ERROR", true]);
  expect(fixture.fake.keys()).toEqual([ticket.key]);
  expect(await status(ticket.id)).toBe("pending");
  setDown(false);
  expect((await complete(fixture, ticket.token)).status).toBe(200);
  expect(await status(ticket.id)).toBe("completed");
});

test("a clean file completes, and the scanner read the stored bytes through the signed URL", async () => {
  const { fixture, reads, upload, status } = scanned();
  const ticket = await upload("quarterly numbers");

  expect((await complete(fixture, ticket.token)).status).toBe(200);

  expect(reads).toEqual(["quarterly numbers"]);
  expect(fixture.fake.keys()).toEqual([ticket.key]);
  expect(await status(ticket.id)).toBe("completed");
});

test("the guide shows this file's recipe", () => {
  const guide = readFileSync(new URL("../../../../docs/guide/plugins.md", import.meta.url), "utf8");
  const block =
    /<!-- scan-recipe -->\n```ts\n([\s\S]*?)```/.exec(guide)?.[1] ?? "<no block after <!-- scan-recipe -->>";
  const source = readFileSync(new URL(import.meta.url), "utf8");
  // The import line and the function, each as it stands here; the imports above also hold the tests' own.
  const pieces = block.replaceAll('"cloudrop"', '"../index.ts"').replace("export function", "function").split("\n\n");
  expect(pieces).toHaveLength(2);
  expect(pieces.filter((piece) => !source.includes(piece))).toEqual([]);
});
