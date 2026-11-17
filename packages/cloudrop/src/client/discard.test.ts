// Contract: discard(upload) (decision M3-U93), through the real client after a simulated reload. It takes the
// upload's lock, sends the record's /abort with its stored token, deletes the record and lets the lock go, and needs
// no file. An upload another holder sends is refused before any request; an /abort that cannot reach the server keeps
// the record for another try; a token the server refuses for good, or a record the browser already deleted as
// expired, discards the record with nothing aborted; an upload that is not listed, or a wrong argument, is refused.
// Oracle: the multipart uploads the fake bucket holds, what the fake IndexedDB holds, the locks the fake LockManager
// holds, the requests the fixture saw, and literal messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gate, partThree, persistFixture, reloaded, serverError, unreachable } from "../testing/persist-fixture.ts";
import { createRecords, type UploadRecord } from "./records.ts";

const brief = (error: { code: string; message: string } | null) =>
  error && { code: error.code, message: error.message };
const abortFault = (answer: () => Promise<Response> | Response) => (call: { label: string; nth: number }) =>
  call.label === "POST /abort" && call.nth === 1 ? answer() : undefined;

/** A listed record of another upload, valid for a day: it must outlive every discard of the upload under test. */
const otherRecord = (changes: Partial<UploadRecord> = {}): UploadRecord => ({
  id: "other",
  namespace: "",
  route: "files",
  metadata: undefined,
  name: "other.bin",
  size: 52_428_800,
  type: "application/octet-stream",
  lastModified: 1_763_200_000_000,
  fingerprint: "ab".repeat(32),
  token: "token-other",
  key: "uploads/other.bin",
  partSize: 10_485_760,
  partCount: 5,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  savedAt: Date.now() - 1000,
  ...changes,
});

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("discard(upload)", () => {
  it("aborts the upload with its stored token, deletes its record, lets its lock go and leaves the other listed", async () => {
    const held = gate(partThree);
    const { client, upload, sent, db, locks, fixture } = await reloaded(held);
    createRecords(true).save(otherRecord());
    await db.settled();
    const pendingBefore = fixture.server.fake.pendingUploads();

    const result = await client.discard(upload);
    await db.settled();

    expect({
      result,
      requests: sent(),
      pending: [pendingBefore, fixture.server.fake.pendingUploads()],
      listed: (await client.resumable()).data?.map(({ id }) => id),
      locks: locks.held(),
    }).toEqual({
      result: { data: { aborted: true }, error: null },
      requests: ["POST /abort"],
      pending: [1, 0],
      listed: ["other"],
      locks: [],
    });
  });

  it("refuses an upload another tab is sending, before any request, and keeps its record", async () => {
    const held = gate(partThree);
    const { client, upload, sent, locks } = await reloaded(held);
    const release = locks.holdElsewhere(`cloudrop:upload:${upload.id}`);

    const result = await client.discard(upload);
    release();

    expect({ error: brief(result.error), requests: sent(), listed: (await client.resumable()).data }).toEqual({
      error: {
        code: "UPLOAD_IN_USE",
        message:
          "This upload is being sent in this browser, in this tab or another. Finish or cancel it there, then try again.",
      },
      requests: [],
      listed: [upload],
    });
  });

  it("keeps the record and lets the lock go when /abort cannot reach the server, so a second try discards it", async () => {
    const held = gate(partThree);
    const { client, upload, locks, fixture } = await reloaded(held, abortFault(unreachable));

    const first = await client.discard(upload);
    const listedAfterFirst = (await client.resumable()).data;
    const lockedAfterFirst = locks.held();
    const second = await client.discard(upload);

    expect({
      first: { error: brief(first.error), retryable: first.error?.retryable },
      listedAfterFirst,
      lockedAfterFirst,
      second,
      pending: fixture.server.fake.pendingUploads(),
    }).toEqual({
      first: {
        error: {
          code: "NETWORK_ERROR",
          message: "The upload server could not be reached. Check the connection, then try again.",
        },
        retryable: true,
      },
      listedAfterFirst: [upload],
      lockedAfterFirst: [],
      second: { data: { aborted: true }, error: null },
      pending: 0,
    });
  });

  it("discards the record with nothing aborted when the server refuses the token for good", async () => {
    const held = gate(partThree);
    const refused = () => serverError(401, "INVALID_TOKEN", "This upload token is not valid. Start the upload again.");
    const { client, upload, db, fixture } = await reloaded(held, abortFault(refused));

    const result = await client.discard(upload);
    await db.settled();

    expect({ result, stored: Object.keys(db.stored()), pending: fixture.server.fake.pendingUploads() }).toEqual({
      result: { data: { aborted: false }, error: null },
      stored: [],
      // The bucket's abort-incomplete-multipart rule removes it.
      pending: 1,
    });
  });

  it("sends nothing for a record the browser already deleted as expired, and says nothing was aborted", async () => {
    const { client, db, fixture } = persistFixture();
    // A minute or less left: resumable() no longer lists it and deletes it (M3-U72).
    const expiring = otherRecord({ expiresAt: new Date(Date.now() + 30_000).toISOString() });
    createRecords(true).save(expiring);
    await db.settled();
    const { id, route, name, size, type, lastModified, expiresAt } = expiring;

    const result = await client.discard({ id, route, name, size, type, lastModified, expiresAt });
    await db.settled();

    expect({ result, requests: fixture.requests, stored: Object.keys(db.stored()) }).toEqual({
      result: { data: { aborted: false }, error: null },
      requests: [],
      stored: [],
    });
  });

  it("refuses an upload that is not listed and has not expired, before any request", async () => {
    const { client, fixture } = persistFixture();
    const gone = { ...otherRecord(), id: "finished-elsewhere" };

    const result = await client.discard(gone);

    expect({ error: brief(result.error), requests: fixture.requests }).toEqual({
      error: {
        code: "NOT_FOUND",
        message:
          "This upload is no longer in this browser's list: it finished, or was cancelled or discarded. Read the list again.",
      },
      requests: [],
    });
  });

  it.each([
    { name: "nothing", upload: undefined },
    { name: "an upload without a string id", upload: { id: 7 } },
  ])("refuses $name with INVALID_INPUT", async ({ upload }) => {
    const { client } = persistFixture();
    // A caller without types, as plain JavaScript passes it.
    const result = await (client.discard as (upload: unknown) => ReturnType<typeof client.discard>)(upload);
    expect(brief(result.error)).toEqual({
      code: "INVALID_INPUT",
      message: "Pass discard() an upload from resumable().",
    });
  });
});
