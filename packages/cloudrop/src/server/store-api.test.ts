import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, files } from "../testing/complete-fixture.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { hello, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { FileApi } from "./api.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A server with one completed file of "u1", whose onComplete answered { saved: true }. */
async function completed() {
  const saved = route(
    { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
    { owner: ({ userId }) => userId, onComplete: () => ({ saved: true }) },
  );
  const fixture = storeFixture({ owned: saved });
  const ticket = await fixture.single("owned", TEXT);
  await fixture.send(ticket.put, hello);
  await complete(fixture, ticket.token);
  return { fixture, ticket };
}

describe("cloudrop.api without a store", () => {
  const calls: [string, (api: FileApi) => Promise<unknown>][] = [
    ["file", (api) => api.file("id")],
    ["usage", (api) => api.usage("u1")],
    ["revokeUploads", (api) => api.revokeUploads({ owner: "u1" })],
    ["deleteFile", (api) => api.deleteFile("id")],
    ["reconcile", (api) => api.reconcile()],
    ["sweep", (api) => api.sweep()],
  ];
  it.for(calls)("%s answers INVALID_CONFIG", async ([name, call]) => {
    const { cloudrop } = serverFixture({ files });
    expect(await call(cloudrop.api)).toEqual({
      data: null,
      error: expect.objectContaining({
        code: "INVALID_CONFIG",
        message: `api.${name} needs a database store. Pass store to createCloudrop.`,
      }),
    });
  });
});

describe("cloudrop.api with a store", () => {
  it("file answers the row, and null for an id without one", async () => {
    const { fixture, ticket } = await completed();
    const { data } = await fixture.cloudrop.api.file(ticket.id);
    expect([data?.status, data?.owner, data?.result, data?.size]).toEqual(["completed", "u1", '{"saved":true}', 5]);
    expect(await fixture.cloudrop.api.file("01J0000000000000000000NONE")).toEqual({ data: null, error: null });
  });

  it("revokeUploads ends the owner's unfinished uploads only, and answers how many", async () => {
    const { fixture, ticket } = await completed();
    const open = await fixture.single("owned", TEXT);
    expect(await fixture.cloudrop.api.revokeUploads({ owner: "u1" })).toEqual({ data: { revoked: 1 }, error: null });
    expect(await fixture.cloudrop.api.revokeUploads({ owner: "u1" })).toEqual({ data: { revoked: 0 }, error: null });
    const statuses = Object.fromEntries((await fixture.store.raw.files()).map((row) => [row.id, row.status]));
    expect(statuses).toEqual({ [ticket.id]: "completed", [open.id]: "aborted" });
    expect((await fixture.cloudrop.api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
  });

  it("deleteFile ends a completed file, deletes its object and releases its bytes, and again does nothing more", async () => {
    const { fixture, ticket } = await completed();
    expect(await fixture.cloudrop.api.deleteFile(ticket.id)).toEqual({ data: { id: ticket.id }, error: null });
    expect(await fixture.cloudrop.api.deleteFile(ticket.id)).toEqual({ data: { id: ticket.id }, error: null });
    const [row] = await fixture.store.raw.files();
    expect([row?.status, row?.endedAt, row?.cleanedAt, (await fixture.storage.head(ticket.key)).data]).toEqual([
      "deleted",
      NOW,
      NOW,
      null,
    ]);
    expect((await fixture.cloudrop.api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
  });

  it("deleteFile finishes a deletion an earlier call left half done", async () => {
    const { fixture, ticket } = await completed();
    // The network drops the first DELETE the server sends.
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) => {
      if (init?.method !== "DELETE") return fetch(input, init);
      fixture.fake.fetch = fetch;
      return Promise.reject(new TypeError("network down"));
    };
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error?.code).toBe("STORAGE_UNREACHABLE");
    expect((await fixture.store.raw.files())[0]?.cleanedAt).toBeNull();
    expect(await fixture.cloudrop.api.deleteFile(ticket.id)).toEqual({ data: { id: ticket.id }, error: null });
    expect([(await fixture.storage.head(ticket.key)).data, (await fixture.store.raw.files())[0]?.cleanedAt]).toEqual([
      null,
      NOW,
    ]);
  });

  it("deleteFile keeps another upload's object stored under the same key since", async () => {
    const { fixture, ticket } = await completed();
    await fixture.cloudrop.api.deleteFile(ticket.id);
    await fixture.storage.put(ticket.key, "newer", { metadata: { "cloudrop-id": "another-upload" } });
    await fixture.cloudrop.api.deleteFile(ticket.id);
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });

  it("deleteFile refuses an id with no completed file", async () => {
    const fixture = storeFixture({ owned });
    const open = await fixture.single("owned", TEXT);
    const expected = {
      data: null,
      error: expect.objectContaining({
        code: "NOT_FOUND",
        message: "No completed file has this id. deleteFile deletes only files whose upload completed.",
      }),
    };
    expect(await fixture.cloudrop.api.deleteFile(open.id)).toEqual(expected);
    expect(await fixture.cloudrop.api.deleteFile("01J0000000000000000000NONE")).toEqual(expected);
    expect((await fixture.store.raw.files())[0]?.status).toBe("pending");
  });

  it("replays the stored answer to a /complete retry after deleteFile, so the client does not upload it again", async () => {
    const { fixture, ticket } = await completed();
    await fixture.cloudrop.api.deleteFile(ticket.id);
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ saved: true });
  });

  it("reconcile repairs drifted counters for one owner, or for every owner page by page", async () => {
    const { fixture } = await completed();
    const drifted = { reservedBytes: 99, activeBytes: 1, files: 7, updatedAt: NOW };
    await fixture.store.raw.putUsage({ owner: "u1", ...drifted });
    await fixture.store.raw.putUsage({ owner: "u2", ...drifted });
    expect(await fixture.cloudrop.api.reconcile({ owner: "u1" })).toEqual({
      data: { checked: 1, repaired: 1 },
      error: null,
    });
    expect(await fixture.cloudrop.api.reconcile()).toEqual({ data: { checked: 2, repaired: 1 }, error: null });
    expect(
      (await fixture.store.raw.usage()).map(({ owner, reservedBytes, activeBytes, files }) => [
        owner,
        reservedBytes,
        activeBytes,
        files,
      ]),
    ).toEqual([
      ["u1", 0, 5, 1],
      ["u2", 0, 0, 0],
    ]);
  });

  it.for([
    { name: "file with an empty id", call: (api: FileApi) => api.file("") },
    { name: "usage with an owner over 255 characters", call: (api: FileApi) => api.usage("x".repeat(256)) },
    { name: "revokeUploads without an owner", call: (api: FileApi) => api.revokeUploads({} as { owner: string }) },
    { name: "reconcile with an empty owner", call: (api: FileApi) => api.reconcile({ owner: "" }) },
  ])("$name answers INVALID_INPUT", async ({ call }) => {
    const fixture = storeFixture({ owned });
    expect((await call(fixture.cloudrop.api)) as object).toEqual({
      data: null,
      error: expect.objectContaining({ code: "INVALID_INPUT" }),
    });
  });
});
