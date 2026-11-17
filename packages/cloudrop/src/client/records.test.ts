// Contract: client/records.ts, the store of unfinished multipart uploads (resume spec §3.1, §3.2, §3.6, §3.7;
// rulings M3-U70 to M3-U72). One record per upload, kept per namespace; expired ones (less than 60 s left) are never
// returned and are deleted when seen; operations apply in the order they were made; uploads never hear of a store
// failure, while list and clear report it as STORAGE_ERROR; off or without IndexedDB nothing is read or written.
// Oracle: what the fake IndexedDB holds (`stored()`: structured clones keyed as the browser keys them), literal
// records and literal timestamps. The fake is the platform boundary; the store under test is the real module.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeIndexedDb, fakeIndexedDb } from "../testing/fake-indexeddb.ts";
import { fakeLocks } from "../testing/fake-locks.ts";
import { createRecords, type Records, type UploadRecord } from "./records.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");

const SAVED: UploadRecord = {
  id: "u-1",
  namespace: "user-1",
  route: "photos",
  metadata: { album: "Trip", tags: ["sea", "sun"], cover: null },
  name: "beach.jpg",
  size: 52_428_800,
  type: "image/jpeg",
  lastModified: 1_763_200_000_000,
  fingerprint: "5d41402abc4b2a76b9719d911017c592",
  token: "v1.eyJ1cGxvYWQiOiJ1LTEifQ.c2ln",
  key: "photos/2026/beach.jpg",
  partSize: 10_485_760,
  partCount: 5,
  expiresAt: "2026-11-17T12:00:00.000Z",
  savedAt: NOW,
};

/** SAVED under another id, namespace, save time or expiry. */
const recordOf = (changes: Partial<UploadRecord>): UploadRecord => ({ ...SAVED, ...changes });

const STORAGE_ERROR = {
  code: "STORAGE_ERROR",
  message:
    "The browser's storage for unfinished uploads could not be read or written. Uploads still work; resuming after a reload may not.",
};

let fake: FakeIndexedDb;
let clock: number;
let opens: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake = fakeIndexedDb();
  opens = vi.spyOn(fake.indexedDB, "open");
  vi.stubGlobal("indexedDB", fake.indexedDB);
  // The store needs Web Locks (M3-U88); a fake, so the rows never depend on the runtime having them.
  vi.stubGlobal("navigator", { locks: fakeLocks().locks });
  clock = NOW;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const storeAt = (): Records => createRecords(true, () => clock);

/**
 * Resolves once every operation queued before it has run (M3-U71): a clear of a namespace no record has, which, unlike
 * a list, deletes no expired record itself.
 */
const afterQueued = (records: Records) => records.clear("nobody");

describe("saving and reading", () => {
  it("keeps every field of a saved record, keyed by its id, and lists a copy of it", async () => {
    const records = storeAt();
    records.save(SAVED);
    const listed = await records.list("user-1");
    expect(listed).toEqual({ data: [SAVED], error: null });
    expect(listed.data?.[0]).not.toBe(SAVED);
    expect(fake.stored()).toEqual({ "u-1": SAVED });
  });

  it("reads in a new client, as after a reload, what an earlier client saved", async () => {
    const before = storeAt();
    before.save(SAVED);
    await afterQueued(before);
    expect(await storeAt().list("user-1")).toEqual({ data: [SAVED], error: null });
  });
});

describe("namespaces", () => {
  it("never mix in list or clear, and clear(null) deletes every record", async () => {
    const records = storeAt();
    records.save(recordOf({ id: "u-1", namespace: "user-1" }));
    records.save(recordOf({ id: "u-2", namespace: "user-12" }));
    records.save(recordOf({ id: "u-3", namespace: "user-12" }));
    records.save(recordOf({ id: "u-4", namespace: "" }));

    expect((await records.list("user-1")).data?.map((record) => record.id)).toEqual(["u-1"]);
    expect(await records.clear("nobody")).toEqual({ data: 0, error: null });
    expect(await records.clear("user-1")).toEqual({ data: 1, error: null });
    expect(Object.keys(fake.stored())).toEqual(["u-2", "u-3", "u-4"]);
    expect(await records.clear(null)).toEqual({ data: 3, error: null });
    expect(fake.stored()).toEqual({});
  });
});

it("lists newest first by savedAt, whatever the id or save order", async () => {
  const records = storeAt();
  records.save(recordOf({ id: "u-1", savedAt: NOW - 2000 }));
  records.save(recordOf({ id: "u-3", savedAt: NOW - 3000 }));
  records.save(recordOf({ id: "u-2", savedAt: NOW - 1000 }));
  expect((await records.list("user-1")).data?.map((record) => record.id)).toEqual(["u-2", "u-1", "u-3"]);
});

describe("expiry (M3-U72: less than 60 000 ms left counts as expired)", () => {
  // Saved a minute earlier, when both had more than 60 s left; now one has 59 999 ms left and the other 60 000.
  const saveBoth = async (records: Records) => {
    clock = NOW - 60_000;
    records.save(recordOf({ id: "u-1", expiresAt: "2026-11-16T12:00:59.999Z" }));
    records.save(recordOf({ id: "u-2", expiresAt: "2026-11-16T12:01:00.000Z" }));
    await afterQueued(records);
    clock = NOW;
  };

  it("list returns the record with 60 000 ms left and deletes the one with 59 999", async () => {
    const records = storeAt();
    await saveBoth(records);
    expect((await records.list("user-1")).data?.map((record) => record.id)).toEqual(["u-2"]);
    expect(Object.keys(fake.stored())).toEqual(["u-2"]);
  });

  it("counts a record whose expiresAt is not a date as expired", async () => {
    const records = storeAt();
    records.save(recordOf({ expiresAt: "tomorrow" }));
    expect(await records.list("user-1")).toEqual({ data: [], error: null });
    expect(fake.stored()).toEqual({});
  });

  it("a save deletes the expired records of every namespace and keeps the live ones", async () => {
    const records = storeAt();
    clock = NOW - 60_000;
    records.save(recordOf({ id: "u-1", namespace: "user-12", expiresAt: "2026-11-16T12:00:59.999Z" }));
    records.save(recordOf({ id: "u-2", namespace: "user-12", expiresAt: "2026-11-16T12:01:00.000Z" }));
    await afterQueued(records);
    clock = NOW;
    records.save(recordOf({ id: "u-3", namespace: "user-1" }));
    await afterQueued(records);
    expect(Object.keys(fake.stored())).toEqual(["u-2", "u-3"]);
  });
});

describe("order (M3-U71: operations apply in the order they were made)", () => {
  it("a remove made right after a save wins", async () => {
    const records = storeAt();
    records.save(SAVED);
    records.remove("u-1");
    await afterQueued(records);
    expect(fake.stored()).toEqual({});
  });

  it("a save made right after a remove of the same id stores the new record", async () => {
    const records = storeAt();
    records.save(recordOf({ savedAt: NOW - 1000 }));
    records.remove("u-1");
    records.save(SAVED);
    await afterQueued(records);
    expect(fake.stored()).toEqual({ "u-1": SAVED });
  });
});

describe("a record still being made (audit C1: the save holds its place in the queue)", () => {
  it("a remove made right after it wins, though the record is ready only later", async () => {
    const records = storeAt();
    const record = Promise.withResolvers<UploadRecord>();
    records.save(record.promise);
    records.remove("u-1");
    record.resolve(SAVED);
    await afterQueued(records);
    expect(fake.stored()).toEqual({});
  });

  it("is stored once ready, before an operation made after it", async () => {
    const records = storeAt();
    const record = Promise.withResolvers<UploadRecord>();
    records.save(record.promise);
    const listed = records.list("user-1");
    record.resolve(SAVED);
    expect(await listed).toEqual({ data: [SAVED], error: null });
  });

  it("is dropped when it cannot be made (a file the browser can no longer read), and the store keeps working", async () => {
    const records = storeAt();
    const first = Promise.withResolvers<UploadRecord>();
    const second = Promise.withResolvers<UploadRecord>();
    records.save(first.promise);
    records.save(second.promise);
    second.reject(new DOMException("The file could not be read.", "NotReadableError"));
    // A task passes while the first save still waits, as a browser's store answers in tasks: Vitest fails the run on a
    // rejection nobody handled by then.
    await new Promise((resolve) => setImmediate(resolve));
    first.resolve(recordOf({ id: "u-0" }));
    records.save(SAVED);
    expect((await records.list("user-1")).data?.map(({ id }) => id)).toEqual(["u-0", "u-1"]);
  });
});

describe("records of another shape (audit M2: another library version or script of the origin)", () => {
  /** Writes `value` into M3-U70's store as another script on the origin would. */
  const putRaw = (value: unknown) =>
    new Promise<void>((resolve) => {
      const request = fake.indexedDB.open("cloudrop", 1) as IDBOpenDBRequest;
      request.onupgradeneeded = () => request.result.createObjectStore("uploads", { keyPath: "id" });
      request.onsuccess = () => {
        const transaction = request.result.transaction("uploads", "readwrite");
        transaction.objectStore("uploads").put(value);
        transaction.oncomplete = () => resolve();
      };
    });

  it.each([
    { name: "a size that is a string", value: { ...SAVED, id: "u-2", size: "52428800" } },
    { name: "no token", value: { ...SAVED, id: "u-2", token: undefined } },
    // 50 MiB in 10 MiB parts is 5 parts, as answers.ts checks a live ticket.
    { name: "a part count its size and part size do not give", value: { ...SAVED, id: "u-2", partCount: 4 } },
    // Math.ceil(size / 0) is Infinity, so the count matches, and resume() would never end its loop (final review M1).
    { name: "a part size of 0 and Infinity parts", value: { ...SAVED, id: "u-2", partSize: 0, partCount: Infinity } },
    // 10,000 parts of 5 MiB and 1 byte more: one part over the limit of S3 and R2.
    {
      name: "10,001 parts",
      value: { ...SAVED, id: "u-2", size: 52_428_800_001, partSize: 5_242_880, partCount: 10_001 },
    },
  ])("are never listed and are deleted when seen: $name", async ({ value }) => {
    await putRaw(SAVED);
    await putRaw(value);
    expect(await storeAt().list("user-1")).toEqual({ data: [SAVED], error: null });
    expect(Object.keys(fake.stored())).toEqual(["u-1"]);
  });

  it("keeps a record of exactly 10,000 parts", async () => {
    const largest = { ...SAVED, size: 52_428_800_000, partSize: 5_242_880, partCount: 10_000 };
    await putRaw(largest);
    expect(await storeAt().list("user-1")).toEqual({ data: [largest], error: null });
  });
});

describe("store failures", () => {
  it("a failed save is dropped, and the store keeps working", async () => {
    const records = storeAt();
    records.save(recordOf({ id: "u-1" }));
    await afterQueued(records);
    fake.failNext("QuotaExceededError");
    records.save(recordOf({ id: "u-2" }));
    expect((await records.list("user-1")).data?.map((record) => record.id)).toEqual(["u-1"]);
    expect(Object.keys(fake.stored())).toEqual(["u-1"]);
  });

  it("a failed read resolves STORAGE_ERROR without the browser's text, and the next read works", async () => {
    const records = storeAt();
    records.save(SAVED);
    await afterQueued(records);
    fake.failNext("UnknownError");
    const failed = await records.list("user-1");
    expect(failed).toMatchObject({ data: null, error: STORAGE_ERROR });
    expect(failed.error?.message).not.toMatch(/UnknownError|fake database/);
    expect(await records.list("user-1")).toEqual({ data: [SAVED], error: null });
  });

  it("a failed open drops the operation, and the next operation opens again and works", async () => {
    const records = storeAt();
    fake.failNext("InvalidStateError");
    records.save(SAVED);
    expect(await records.list("user-1")).toEqual({ data: [], error: null });
    expect(fake.stored()).toEqual({});
    fake.failNext("UnknownError");
    expect(await records.list("user-1")).toMatchObject({ data: null, error: STORAGE_ERROR });
    records.save(SAVED);
    expect(await records.list("user-1")).toEqual({ data: [SAVED], error: null });
    // The save's open failed and the first list's worked; the failed list's request kept that connection.
    expect(opens).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "closes it and says so", notify: true },
    { name: "closes it without a word", notify: false },
  ])("opens a new connection when the browser $name", async ({ notify }) => {
    const records = storeAt();
    records.save(SAVED);
    await afterQueued(records);
    fake.closeConnections(notify);
    // Without a word, the first operation finds the connection dead and fails; the next one opens again.
    const first = await records.list("user-1");
    expect(first).toMatchObject(notify ? { data: [SAVED], error: null } : { data: null, error: STORAGE_ERROR });
    expect(await records.list("user-1")).toEqual({ data: [SAVED], error: null });
    expect(opens).toHaveBeenCalledTimes(2);
  });
});

describe.each([
  { name: "persist is off", make: () => createRecords(false, () => clock) },
  {
    name: "the runtime has no indexedDB",
    make: () => {
      vi.unstubAllGlobals();
      return createRecords(true, () => clock);
    },
  },
])("when $name", ({ make }) => {
  it("lists [], clears 0 and never opens a database", async () => {
    const records = make();
    records.save(SAVED);
    records.remove("u-1");
    expect(await records.list("user-1")).toEqual({ data: [], error: null });
    expect(await records.clear(null)).toEqual({ data: 0, error: null });
    expect(opens).not.toHaveBeenCalled();
  });
});

it("opens M3-U70's database once, lazily, for every operation of a client", async () => {
  const records = storeAt();
  expect(opens).not.toHaveBeenCalled();
  records.save(SAVED);
  records.remove("u-2");
  await records.list("user-1");
  await records.clear("user-12");
  expect(opens.mock.calls).toEqual([["cloudrop", 1]]);
});
