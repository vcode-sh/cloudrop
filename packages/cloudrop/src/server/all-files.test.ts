import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, files } from "../testing/complete-fixture.ts";
import { type MemoryStore, memoryStore } from "../testing/memory-store.ts";
import { hello, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { AllFilesOptions } from "./all-files.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const other = route({ accept: "*/*", maxSize: "1GB", authorize: () => ({}) }, { owner: () => "u2" });
const OTHER_LISTING =
  "INVALID_INPUT: cursor belongs to a listing with another owner, status, route, name, type or order. Pass the options of the page that returned it, or leave cursor out to start again.";

type Fixture = ReturnType<typeof storeFixture>;

/** One upload on `routeName`, `minutes` after NOW, completed unless `finish` is false. Answers the file's id. */
async function uploadAt(fixture: Fixture, routeName: string, minutes: number, finish = true): Promise<string> {
  vi.setSystemTime(NOW.getTime() + minutes * 60_000);
  const ticket = await fixture.single(routeName, TEXT);
  if (finish) {
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
  }
  return ticket.id;
}

/**
 * Four uploads a minute apart: "u1" completes one on `owned`, "u2" one on `other`, nobody's completes on `files`, and
 * "u1" leaves a last one pending.
 */
async function uploads() {
  const fixture = storeFixture({ owned, other, files });
  const mine = await uploadAt(fixture, "owned", 1);
  const theirs = await uploadAt(fixture, "other", 2);
  const nobodys = await uploadAt(fixture, "files", 3);
  const pending = await uploadAt(fixture, "owned", 4, false);
  return { api: fixture.cloudrop.api, fixture, mine, theirs, nobodys, pending };
}

const idsOf = (page: { data: { items: { id: string }[] } | null }) => page.data?.items.map((file) => file.id);

describe("cloudrop.api.allFiles", () => {
  it("lists the files of every owner in any status, those without an owner included, a page at a time", async () => {
    const { api, mine, theirs, nobodys, pending } = await uploads();
    const first = await api.allFiles({ limit: 3 });
    expect(idsOf(first)).toEqual([pending, nobodys, theirs]);
    expect(first.data?.items[0]).toEqual((await api.file(pending)).data);
    const rest = await api.allFiles({ limit: 3, cursor: first.data?.cursor ?? undefined });
    expect(rest).toEqual({ data: { items: [(await api.file(mine)).data], cursor: null }, error: null });
    // With no options at all it is the same listing, 100 a page.
    expect(idsOf(await api.allFiles())).toEqual([pending, nobodys, theirs, mine]);
  });

  it("reads a null cursor, which the last page answers, as no cursor, in allFiles and in files", async () => {
    // A loop that starts with `cursor = null` and passes back what each page answered was refused (M11-R64).
    const { api, mine, theirs, nobodys, pending } = await uploads();
    expect(idsOf(await api.allFiles({ cursor: null }))).toEqual([pending, nobodys, theirs, mine]);
    expect(await api.files({ owner: "u1", cursor: null })).toEqual({
      data: { items: [(await api.file(mine)).data], cursor: null },
      error: null,
    });
  });

  it("narrows to an owner, a status, a route, a name and a type, oldest first when asked", async () => {
    const { api, mine, theirs, nobodys, pending } = await uploads();
    expect({
      owner: idsOf(await api.allFiles({ owner: "u1" })),
      status: idsOf(await api.allFiles({ status: "completed" })),
      pendingOfOwner: idsOf(await api.allFiles({ owner: "u1", status: "pending" })),
      route: idsOf(await api.allFiles({ route: "files" })),
      oldest: idsOf(await api.allFiles({ name: "HELLO", type: "TEXT/", order: "oldest" })),
      noMatch: idsOf(await api.allFiles({ owner: "u2", status: "deleted" })),
    }).toEqual({
      owner: [pending, mine],
      status: [nobodys, theirs, mine],
      pendingOfOwner: [pending],
      route: [nobodys],
      oldest: [mine, theirs, nobodys, pending],
      noMatch: [],
    });
  });

  it("gives cursors that page only the listing that made them, never another one or api.files", async () => {
    const { api, fixture, pending } = await uploads();
    const cursor = (await api.allFiles({ owner: "u1", limit: 1 })).data?.cursor ?? undefined;
    expect(cursor).toMatch(/^all\.[0-9a-f]{8}\.\d+:/);
    expect(idsOf(await api.allFiles({ owner: "u1", limit: 1 }))).toEqual([pending]);
    // A second completed file of "u1", so api.files has a next page and answers a cursor.
    await uploadAt(fixture, "owned", 5);
    const plain = (await api.files({ owner: "u1", limit: 1 })).data?.cursor;
    const marked = (await api.files({ owner: "u1", order: "oldest", limit: 1 })).data?.cursor;
    expect([plain, marked]).toEqual([expect.stringMatching(/^\d+:/), expect.stringMatching(/^[0-9a-f]{8}\.\d+:/)]);
    const elsewhere: AllFilesOptions[] = [
      { cursor },
      { owner: "u2", cursor },
      { owner: "u1", status: "completed", cursor },
      { owner: "u1", route: "owned", cursor },
      { owner: "u1", name: "hello", cursor },
      { owner: "u1", type: "text/", cursor },
      { owner: "u1", order: "oldest", cursor },
      { owner: "u1", cursor: plain ?? undefined },
      { owner: "u1", order: "oldest", cursor: marked ?? undefined },
    ];
    const refused = await Promise.all(elsewhere.map((options) => api.allFiles(options)));
    expect(refused.map(({ error }) => `${error?.code}: ${error?.message}`)).toEqual(elsewhere.map(() => OTHER_LISTING));
  });

  it("has its cursors refused by api.files, for its default listing and a filtered one", async () => {
    const { api } = await uploads();
    const everyone = (await api.allFiles({ limit: 1 })).data?.cursor ?? undefined;
    const oldest = (await api.allFiles({ owner: "u1", order: "oldest", limit: 1 })).data?.cursor ?? undefined;
    const refused = await Promise.all([
      api.files({ owner: "u1", cursor: everyone }),
      api.files({ owner: "u1", order: "oldest", cursor: oldest }),
    ]);
    const message =
      "INVALID_INPUT: cursor belongs to a listing with another route, name, type or order. Pass the options of the page that returned it, or leave cursor out to start again.";
    expect(refused.map(({ error }) => `${error?.code}: ${error?.message}`)).toEqual([message, message]);
  });

  it("keeps a listing that names an owner inside that owner, whatever position a forged cursor names", async () => {
    const { api, fixture, mine, theirs, pending } = await uploads();
    const cursor = (await api.allFiles({ owner: "u1", limit: 1 })).data?.cursor ?? "";
    const mark = cursor.slice(0, cursor.lastIndexOf(".") + 1);
    const [row] = (await fixture.store.raw.files()).filter((file) => file.id === theirs);
    // The mark is a hash anyone can copy: after it, a position far in the future and one on another owner's file.
    const future = await api.allFiles({ owner: "u1", cursor: `${mark}${NOW.getTime() + 3_600_000}:zzzz` });
    expect(idsOf(future)).toEqual([pending, mine]);
    const onTheirs = await api.allFiles({ owner: "u1", cursor: `${mark}${row?.createdAt.getTime()}:${theirs}` });
    expect(idsOf(onTheirs)).toEqual([mine]);
  });

  it.for([
    { name: "options that are not an object", options: "u1" },
    { name: "an empty owner", options: { owner: "" } },
    { name: "an owner that is null", options: { owner: null } },
    { name: "a status that is null", options: { status: null } },
    // The filters, the limit and the cursor are api.files's own (owner-files.ts), refused in its tests: one row here
    // shows this method reads them too.
    { name: "a limit of 0", options: { limit: 0 } },
  ])("refuses $name with INVALID_INPUT", async ({ options }) => {
    const fixture = storeFixture({ owned });
    const { data, error } = await fixture.cloudrop.api.allFiles(options as AllFilesOptions);
    expect({ data, code: error?.code }).toEqual({ data: null, code: "INVALID_INPUT" });
  });

  // The position is read before the mark: a cursor without one was made by no page, whatever listing its mark names.
  it("refuses a marked cursor without a position as one no page returned", async () => {
    const fixture = storeFixture({ owned });
    const { error } = await fixture.cloudrop.api.allFiles({ cursor: "all.0123abcd." });
    expect(`${error?.code}: ${error?.message}`).toBe(
      "INVALID_INPUT: cursor must be one an earlier page of files returned. Leave it out for the first page.",
    );
  });

  it("refuses an owner key whose value is undefined, so a user id lost by a bug never lists every owner", async () => {
    const { api, pending, nobodys, theirs, mine } = await uploads();
    const session: { userId?: string } = {};
    const { data, error } = await api.allFiles({ owner: session.userId, status: "completed" });
    expect({ data, error: `${error?.code}: ${error?.message}` }).toEqual({
      data: null,
      error:
        "INVALID_INPUT: owner is undefined. Pass the owner's id to list that owner's files, or leave the owner key out to list every owner's files.",
    });
    // Only a call without the key crosses owners; another option that is undefined is one left out.
    expect(idsOf(await api.allFiles({ status: undefined }))).toEqual([pending, nobodys, theirs, mine]);
  });

  it("refuses a status that is not one, naming the eight", async () => {
    const fixture = storeFixture({ owned });
    const { error } = await fixture.cloudrop.api.allFiles({ status: "done" } as unknown as AllFilesOptions);
    expect(`${error?.code}: ${error?.message}`).toBe(
      "INVALID_INPUT: status must be one of pending, completing, completed, aborted, rejected, failed, expired, deleted.",
    );
  });

  it("answers INVALID_CONFIG naming listAll on a store written before 0.6, whose api.files still works", async () => {
    const { listAll: _listAll, ...before } = memoryStore();
    // Cast: the fixture is typed for the whole memory store, and this one lacks the method on purpose.
    const { api } = storeFixture({ owned }, { store: before as MemoryStore }).cloudrop;
    const { data, error } = await api.allFiles({ owner: "u1" });
    expect({ data, code: error?.code, message: error?.message }).toEqual({
      data: null,
      code: "INVALID_CONFIG",
      message:
        "api.allFiles needs the store's listAll method. Add it to your store as CloudropStore describes it; cloudrop's own stores have it.",
    });
    expect(await api.files({ owner: "u1" })).toEqual({ data: { items: [], cursor: null }, error: null });
  });

  it.for([
    { name: "the owner", options: { owner: "u2" }, whose: "owner u2" },
    { name: "the status", options: { status: "pending" }, whose: "every owner" },
    { name: "the order", options: { order: "oldest" }, whose: "every owner" },
  ] as const)("refuses the page of a store whose listAll ignores $name", async ({ options, whose }) => {
    const store = memoryStore();
    const ignoring = { ...store, listAll: () => store.listAll({ ...EVERYTHING }) };
    const fixture = storeFixture({ owned, other, files }, { store: ignoring });
    await uploadAt(fixture, "owned", 1);
    await uploadAt(fixture, "other", 2);
    const { data, error } = await fixture.cloudrop.api.allFiles(options);
    expect({ data, code: error?.code, retryable: error?.retryable }).toEqual({
      data: null,
      code: "SERVER_ERROR",
      retryable: false,
    });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: the store's listAll answered files outside the owner, status, route, name, type or order asked for (${whose}). A store written by hand must apply every option listAll receives.`,
    ]);
  });
});

/** The listing of every row, newest first: what a `listAll` that ignores its options answers. */
const EVERYTHING = {
  owner: null,
  status: null,
  route: null,
  name: null,
  type: null,
  order: "newest",
  limit: 100,
  cursor: null,
} as const;
