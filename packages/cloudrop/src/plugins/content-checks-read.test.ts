// Contract: M10-K1 and M10-K6. What contentChecks() reads from the bucket at /complete: the first 4 KiB at most, nothing
// of an empty file, a multipart upload once it is completed; and a read that fails keeps the object for a retry.
// Oracle: the Range header of each GET the fake bucket saw, and what it holds afterwards.

import { describe, expect, it } from "vitest";
import type { SignedPart } from "../protocol/types.ts";
import { allowAnyone, route } from "../server/route.ts";
import { complete } from "../testing/complete-fixture.ts";
import { HTML, TEXT } from "../testing/file-samples.ts";
import { type ServerFixture, serverFixture } from "../testing/server-fixture.ts";
import { contentChecks } from "./content-checks.ts";

/** A server with contentChecks holding `body`, uploaded as text to a route that takes any file, not completed. */
async function uploaded(body: Uint8Array<ArrayBuffer>) {
  const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });
  const fixture = serverFixture({ files }, { plugins: [contentChecks()] });
  const ticket = await fixture.single("files", { name: "a.txt", type: "text/plain", size: body.length });
  expect((await fixture.send(ticket.put, body)).status).toBe(200);
  return { fixture, ticket };
}

describe("contentChecks: reading the bucket", () => {
  /** The Range header of each GET the server sends from now on. */
  function recordRanges(fixture: ServerFixture): (string | null)[] {
    const ranges: (string | null)[] = [];
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) => {
      if ((init?.method ?? "GET") === "GET") ranges.push(new Headers(init?.headers).get("range"));
      return fetch(input, init);
    };
    return ranges;
  }

  it.for([
    { name: "the first 4 KiB of a larger file", size: 10_000, ranges: ["bytes=0-4095"] },
    { name: "a file of exactly 4 KiB whole", size: 4096, ranges: ["bytes=0-4095"] },
    { name: "a one-byte file whole", size: 1, ranges: ["bytes=0-0"] },
    // R2 answers any range of an empty object with 416 InvalidRange (measured 2026-11-21).
    { name: "nothing of an empty file", size: 0, ranges: [] },
  ])("reads $name", async ({ size, ranges }) => {
    const { fixture, ticket } = await uploaded(new Uint8Array(size).fill(0x41));
    const sent = recordRanges(fixture);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    expect(sent).toEqual(ranges);
  });

  it("completes, reads and deletes a refused multipart upload", async () => {
    const files = route({ accept: "image/*", maxSize: "1MB", authorize: allowAnyone });
    const fixture = serverFixture({ files }, { plugins: [contentChecks()], multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", { name: "a.png", type: "image/png", size: HTML.length });
    await fixture.send(ticket.parts[0] as SignedPart, HTML);
    expect((await complete(fixture, ticket.token)).body.error?.code).toBe("FILE_TYPE_NOT_ALLOWED");
    expect([fixture.fake.keys(), fixture.fake.pendingUploads()]).toEqual([[], 0]);
  });

  it("keeps the object and asks the client to retry when the bucket cannot be read", async () => {
    const { fixture, ticket } = await uploaded(TEXT);
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      (init?.method ?? "GET") === "GET" ? Promise.reject(new TypeError("network down")) : fetch(input, init);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
      retryable: true,
    });
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
    fixture.fake.fetch = fetch;
    expect((await complete(fixture, ticket.token)).status).toBe(200);
  });
});
