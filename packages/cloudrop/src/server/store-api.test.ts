import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, files } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { hello, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { FileApi } from "./api.ts";
import type { FilesOptions } from "./owner-files.ts";
import { route } from "./route.ts";

const HOUR = 3_600_000;
/** When a check of the bucket for a file completed at NOW is final: a URL signed as the completion claimed the file
 *  works 15 minutes more, then the default grace, an hour. */
const SETTLED = NOW.getTime() + 15 * 60_000 + HOUR;

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
    ["files", (api) => api.files({ owner: "u1" })],
    ["allFiles", (api) => api.allFiles()],
    ["deleteFile", (api) => api.deleteFile("id")],
    ["eraseOwner", (api) => api.eraseOwner("u1")],
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

  it("deleteFile ends a completed file, deletes its object and releases its bytes, and says which call deleted it", async () => {
    const { fixture, ticket } = await completed();
    const { id } = ticket;
    const { api } = fixture.cloudrop;
    expect(await api.deleteFile(id)).toEqual({ data: { id, deleted: true, cleaned: false }, error: null });
    expect(await api.deleteFile(id)).toEqual({ data: { id, deleted: false, cleaned: false }, error: null });
    const [row] = await fixture.store.raw.files();
    // Completed a moment ago, so a PUT with one of its URLs could still land: cleaned_at stays null for the sweep.
    expect([row?.status, row?.endedAt, row?.cleanedAt, (await fixture.storage.head(ticket.key)).data]).toEqual([
      "deleted",
      NOW,
      null,
      null,
    ]);
    expect((await fixture.cloudrop.api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
  });

  it("deleteFile marks a file cleaned once its URLs and the grace after them have passed, and then looks no more", async () => {
    const { fixture, ticket } = await completed();
    const { id } = ticket;
    const { api } = fixture.cloudrop;
    vi.setSystemTime(SETTLED - 1);
    expect((await api.deleteFile(id)).data).toEqual({ id, deleted: true, cleaned: false });
    expect((await fixture.store.raw.files())[0]?.cleanedAt).toBeNull();
    vi.setSystemTime(SETTLED);
    expect((await api.deleteFile(id)).data).toEqual({ id, deleted: false, cleaned: true });
    expect((await fixture.store.raw.files())[0]?.cleanedAt).toEqual(new Date(SETTLED));
    const before = fixture.storageCalls.length;
    expect((await api.deleteFile(id)).data).toEqual({ id, deleted: false, cleaned: true });
    expect(fixture.storageCalls.slice(before)).toEqual([]);
  });

  it("deleteFile of a file whose URLs and grace ran out before answers deleted and cleaned at once", async () => {
    const { fixture, ticket } = await completed();
    vi.setSystemTime(SETTLED);
    const { data } = await fixture.cloudrop.api.deleteFile(ticket.id);
    expect(data).toEqual({ id: ticket.id, deleted: true, cleaned: true });
  });

  // The row is deleted, so the file is gone for its owner whatever the bucket answers (M11-D2).
  it("deleteFile answers success when the object cannot be removed, logs it, and a later call removes it", async () => {
    const { fixture, ticket } = await completed();
    const { id } = ticket;
    const { api } = fixture.cloudrop;
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      init?.method === "DELETE" ? Promise.reject(new TypeError("network down")) : fetch(input, init);
    // Past the grace, where a check that worked would be final.
    vi.setSystemTime(SETTLED);
    expect(await api.deleteFile(id)).toEqual({ data: { id, deleted: true, cleaned: false }, error: null });
    // The same for a call that finds the row deleted by an earlier one.
    expect(await api.deleteFile(id)).toEqual({ data: { id, deleted: false, cleaned: false }, error: null });
    const logged = {
      message: `cloudrop: could not remove the deleted file ${id} from the bucket. The sweep removes it later.`,
      error: expect.objectContaining({ code: "STORAGE_UNREACHABLE" }),
    };
    expect(fixture.logger.errors).toEqual([logged, logged]);
    expect([
      (await fixture.store.raw.files())[0]?.cleanedAt,
      (await fixture.storage.head(ticket.key)).data?.size,
    ]).toEqual([null, 5]);
    expect((await api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
    fixture.fake.fetch = fetch;
    expect((await api.deleteFile(id)).data).toEqual({ id, deleted: false, cleaned: true });
    expect((await fixture.storage.head(ticket.key)).data).toBeNull();
  });

  it("deleteFile answers success when the store fails to mark the deleted file cleaned, and a later call marks it", async () => {
    const { fixture, ticket } = await completed();
    const { id } = ticket;
    const { api } = fixture.cloudrop;
    vi.setSystemTime(SETTLED);
    fixture.store.injectFailure("cleaned", 0);
    expect(await api.deleteFile(id)).toEqual({ data: { id, deleted: true, cleaned: false }, error: null });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: the store failed to mark file ${id} cleaned.`,
    ]);
    expect((await api.deleteFile(id)).data).toEqual({ id, deleted: false, cleaned: true });
  });

  it("deleteFile answers a retryable SERVER_ERROR when the store fails to delete, and keeps the file", async () => {
    const { fixture, ticket } = await completed();
    const { api } = fixture.cloudrop;
    fixture.store.injectFailure("end", 0);
    expect(await api.deleteFile(ticket.id)).toEqual({
      data: null,
      error: expect.objectContaining({
        code: "SERVER_ERROR",
        retryable: true,
        message: "The server could not reach its upload records. Try again in a moment.",
      }),
    });
    expect([(await api.file(ticket.id)).data?.status, (await fixture.storage.head(ticket.key)).data?.size]).toEqual([
      "completed",
      5,
    ]);
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, deleted: true, cleaned: false });
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
    // Postgres text cannot hold U+0000: the store would fail, and a retryable SERVER_ERROR would ask for retries.
    { name: "deleteFile with a NUL character in the id", call: (api: FileApi) => api.deleteFile("f\u0000") },
    { name: "eraseOwner with a NUL character in the owner", call: (api: FileApi) => api.eraseOwner("u\u0000") },
  ])("$name answers INVALID_INPUT", async ({ call }) => {
    const fixture = storeFixture({ owned });
    expect((await call(fixture.cloudrop.api)) as object).toEqual({
      data: null,
      error: expect.objectContaining({ code: "INVALID_INPUT" }),
    });
  });
});

describe("cloudrop.api.files", () => {
  const ownedBy = (userId: string) =>
    route({ accept: "*/*", maxSize: "1GB", authorize: () => ({ userId }) }, { owner: ({ userId }) => userId });

  /** Uploads and completes one file on `routeName`, `minutes` after NOW, and answers its id. */
  async function uploadAt(fixture: ReturnType<typeof storeFixture>, routeName: string, minutes: number) {
    vi.setSystemTime(NOW.getTime() + minutes * 60_000);
    const ticket = await fixture.single(routeName, TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    return ticket.id;
  }

  it("lists an owner's completed files, newest first, a page at a time", async () => {
    const fixture = storeFixture({ owned, docs: owned, other: ownedBy("u2") });
    const first = await uploadAt(fixture, "owned", 1);
    const second = await uploadAt(fixture, "docs", 2);
    const third = await uploadAt(fixture, "owned", 3);
    await uploadAt(fixture, "other", 4);
    await fixture.single("owned", TEXT);
    const { api } = fixture.cloudrop;
    const page = await api.files({ owner: "u1", limit: 2 });
    expect(page.data?.items.map((file) => file.id)).toEqual([third, second]);
    expect(page.data?.items[0]).toEqual((await api.file(third)).data);
    const rest = await api.files({ owner: "u1", limit: 2, cursor: page.data?.cursor ?? undefined });
    expect(rest).toEqual({ data: { items: [(await api.file(first)).data], cursor: null }, error: null });
    expect((await api.files({ owner: "u1", route: "owned" })).data?.items.map((file) => file.id)).toEqual([
      third,
      first,
    ]);
  });

  it("filters by name and type, in either order, each listing paging only with its own cursors", async () => {
    const fixture = storeFixture({ owned });
    const { api } = fixture.cloudrop;
    const uploaded: string[] = [];
    for (const [minutes, name, type] of [
      [1, "Q3 Report.PDF", "application/pdf"],
      [2, "photo.png", "image/png"],
      [3, "report.txt", "text/plain"],
      [4, "café.txt", "text/plain"],
    ] as const) {
      vi.setSystemTime(NOW.getTime() + minutes * 60_000);
      const ticket = await fixture.single("owned", { name, size: 5, type });
      await fixture.send(ticket.put, hello);
      expect((await complete(fixture, ticket.token)).status).toBe(200);
      uploaded.push(ticket.id);
    }
    const [pdf, png, txt, cafe] = uploaded;
    const listed = async (options: object) =>
      (await api.files({ owner: "u1", ...options })).data?.items.map((file) => file.id);
    expect(await listed({ name: "REPORT" })).toEqual([txt, pdf]);
    // Names are stored in NFC, so a decomposed é finds the composed one.
    expect(await listed({ name: "cafe\u0301" })).toEqual([cafe]);
    expect(await listed({ name: "", type: "IMAGE/" })).toEqual([png]);
    expect(await listed({ type: "text/plain", order: "oldest" })).toEqual([txt, cafe]);
    const first = await api.files({ owner: "u1", order: "oldest", limit: 2 });
    expect(first.data?.items.map((file) => file.id)).toEqual([pdf, png]);
    const cursor = first.data?.cursor ?? undefined;
    const next = await api.files({ owner: "u1", order: "oldest", limit: 2, cursor });
    expect(next.data?.items.map((file) => file.id)).toEqual([txt, cafe]);
    const elsewhere = [
      { owner: "u1", cursor },
      { owner: "u1", order: "oldest", name: "report", cursor },
      { owner: "u1", order: "oldest", route: "owned", cursor },
    ];
    const refused = await Promise.all(elsewhere.map((options) => api.files(options as FilesOptions)));
    const otherListing =
      "INVALID_INPUT: cursor belongs to a listing with another route, name, type or order. Pass the options of the page that returned it, or leave cursor out to start again.";
    expect(refused.map(({ error }) => `${error?.code}: ${error?.message}`)).toEqual(elsewhere.map(() => otherListing));
    // The default listing's cursor is a plain one, as 0.3 made, and is refused by a filtered listing all the same.
    const plain = (await api.files({ owner: "u1", limit: 1 })).data?.cursor ?? undefined;
    expect(plain).toMatch(/^\d+:/);
    expect((await api.files({ owner: "u1", type: "text/", cursor: plain })).error?.code).toBe("INVALID_INPUT");
  });

  it("refuses the unfiltered page of a store written for 0.3, which ignores name, type and order", async () => {
    const store = memoryStore();
    const fixture = storeFixture(
      { owned },
      {
        store: {
          ...store,
          list: ({ owner, statuses, route, limit, cursor }) =>
            store.list({ owner, statuses, route, limit, cursor, name: null, type: null, order: "newest" }),
        },
      },
    );
    await uploadAt(fixture, "owned", 1);
    await uploadAt(fixture, "owned", 2);
    const { api } = fixture.cloudrop;
    expect((await api.files({ owner: "u1" })).data?.items).toHaveLength(2);
    expect((await api.files({ owner: "u1", name: "hello" })).data?.items).toHaveLength(2);
    for (const options of [{ type: "image/" }, { name: "report" }, { order: "oldest" as const }]) {
      const { data, error } = await api.files({ owner: "u1", ...options });
      expect({ data, code: error?.code, retryable: error?.retryable }).toEqual({
        data: null,
        code: "SERVER_ERROR",
        retryable: false,
      });
    }
  });

  it.for([
    { name: "a name with a NUL character", options: { owner: "u1", name: "a\u0000" } },
    { name: "a name over 255 characters", options: { owner: "u1", name: "x".repeat(256) } },
    // /upload refuses such names, so no row has one, and the backends need not agree on how to compare one.
    { name: "a name with a lone surrogate", options: { owner: "u1", name: "a\uD800" } },
    { name: "a type without its slash", options: { owner: "u1", type: "image" } },
    { name: "an accept pattern for a type", options: { owner: "u1", type: "image/*" } },
    { name: "an order that is not newest or oldest", options: { owner: "u1", order: "latest" } },
    { name: "an owner over 255 characters", options: { owner: "x".repeat(256) } },
    { name: "a route the server does not have", options: { owner: "u1", route: "avatars" } },
    { name: "a limit over 1000", options: { owner: "u1", limit: 1001 } },
    { name: "a cursor no listing returned", options: { owner: "u1", cursor: "page-2" } },
    { name: "a cursor with a NUL character", options: { owner: "u1", cursor: "1763380800000:\u0000" } },
    // 9999-12-31T23:59:59.999Z is the last time an ISO string without a sign, which Postgres reads, can name.
    { name: "a cursor after the year 9999", options: { owner: "u1", cursor: "253402300800000:f" } },
  ])("refuses $name with INVALID_INPUT", async ({ options }) => {
    const fixture = storeFixture({ owned });
    expect((await fixture.cloudrop.api.files(options as FilesOptions)).error?.code).toBe("INVALID_INPUT");
  });
});
