// Contract: the account guard of POST /upload (M10-A). On a route with a store and `owner`, a request whose
// x-cloudrop-account header (the client's `account` option, percent-encoded) differs from owner()'s answer is refused
// whole with ACCOUNT_CHANGED, not retryable, before any plugin, reservation or storage call. Without the header, on a
// route without an owner, or when owner() answers null, the header changes nothing. A refusal `authorize` returns is
// answered first: owner(), the account check and the plugins never run (M12-R72).
// Oracle: the error body, the store's rows, the plugin and storage calls the request reached, literal strings.

import { describe, expect, it } from "vitest";
import type { UploadResponse } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { storeFixture } from "../testing/store-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { allowAnyone, rateLimited, route } from "./route.ts";

const note = { name: "note.txt", size: 5, type: "text/plain" };
// Over the multipart threshold below, so an accepted file costs a storage call (CreateMultipartUpload).
const video = { name: "clip.mp4", size: 9 * MiB, type: "video/mp4" };
const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });
const accountChanged = {
  code: "ACCOUNT_CHANGED",
  message:
    "The account signed in on this site changed since this page was loaded, so the upload was not started. Reload the page, then upload the file again.",
  retryable: false,
};

/** Records every beforeUpload it is asked, so a test can tell whether one ran. */
function watcher(calls: string[]): CloudropPlugin {
  return { id: "watcher", server: { beforeUpload: ({ files }) => void calls.push(...files.map((file) => file.name)) } };
}

/** A server whose route "owned" belongs to `owner`, with the plugin calls it reaches. */
function ownedBy(owner: string | null) {
  const plugins: string[] = [];
  const fixture = storeFixture(
    { owned: route({ accept: "*/*", maxSize: "10MB", authorize: allowAnyone }, { owner: () => owner }) },
    { plugins: [watcher(plugins)], multipartThreshold: 8 * MiB },
  );
  const upload = (account?: string) =>
    fixture.post(
      "upload",
      { route: "owned", files: [video] },
      account === undefined ? {} : { "x-cloudrop-account": account },
    );
  return { fixture, plugins, upload };
}

const kinds = async (response: Response) => ((await response.json()) as UploadResponse).files.map((file) => file.kind);

describe("POST /upload with the account header", () => {
  it.for([
    { name: "another account", owner: "u1", account: "u2" },
    // %E0%A4%A is not a whole UTF-8 sequence, so it names nobody: not even an owner spelled the same.
    { name: "a header that is not percent-encoded text", owner: "%E0%A4%A", account: "%E0%A4%A" },
    { name: "the empty account of a page where nobody was signed in", owner: "u1", account: "" },
  ])("refuses $name whole, before any plugin, reservation or storage call", async ({ owner, account }) => {
    const { fixture, plugins, upload } = ownedBy(owner);
    const response = await upload(account);

    expect({
      status: response.status,
      body: await response.json(),
      rows: await fixture.store.raw.files(),
      plugins,
      storage: fixture.storageCalls,
    }).toEqual({ status: 409, body: { error: accountChanged }, rows: [], plugins: [], storage: [] });
  });

  it.for([
    { name: "the same account", owner: "u1", account: "u1" },
    {
      name: "the same account, percent-encoded as the client sends it",
      owner: "Zoë 42/ü",
      account: "Zo%C3%AB%2042%2F%C3%BC",
    },
    { name: "no header, as an older page sends", owner: "u1", account: undefined },
    { name: "an owner() that answers null for this request", owner: null, account: "u2" },
  ])("accepts $name", async ({ owner, account }) => {
    const { fixture, plugins, upload } = ownedBy(owner);
    const response = await upload(account);

    expect({ kinds: await kinds(response), rows: (await fixture.store.raw.files()).length, plugins }).toEqual({
      kinds: ["multipart"],
      rows: 1,
      plugins: ["clip.mp4"],
    });
  });

  it("answers a refusal from authorize before owner(), the account check and any plugin", async () => {
    const calls: string[] = [];
    const owned = route(
      { accept: "*/*", maxSize: "10MB", authorize: () => rateLimited(30) },
      {
        owner: () => {
          calls.push("owner");
          return "u1";
        },
      },
    );
    const fixture = storeFixture({ owned }, { plugins: [watcher(calls)] });
    const response = await fixture.post("upload", { route: "owned", files: [note] }, { "x-cloudrop-account": "u2" });

    expect({ status: response.status, code: (await response.json()).error.code, calls }).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      calls: [],
    });
  });

  // A route needs a store for owner, so this is also every server without one.
  it("ignores the header on a route without owner", async () => {
    const fixture = storeFixture({ files });
    const response = await fixture.post("upload", { route: "files", files: [note] }, { "x-cloudrop-account": "u2" });
    expect(await kinds(response)).toEqual(["single"]);
  });
});
