// Contract: M11-R90 on the real server with a store and a quota that fits the file once, through the real client with
// its records and locks. Wherever the client asks /upload for a ticket that replaces one it held, the old ticket is
// given up first, so the bytes its pending row reserved no longer have the new /upload refused until the sweep. A
// resumed upload that starts over (M3-U74) sends its /abort as a retry that replaces a ticket does (M11-R89), and
// never for a ticket a /complete may have finished. A retry after pagehide kept the ticket for a resume (M4-F1)
// discards that upload first, under its lock, so never while another tab resumes it (M11-R91).
// Oracle: the requests the fixture saw, the file's outcome, and the rows read straight from the store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type FileOutcome } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, type FaultCall } from "../testing/client-fixture.ts";
import { fakeIndexedDb } from "../testing/fake-indexeddb.ts";
import { fakeLocks } from "../testing/fake-locks.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { pageEvents } from "../testing/page-events.ts";
import {
  FOUR_PARTS,
  fourParts,
  gate,
  lockOf,
  partThree,
  reloaded,
  serverError,
  unreachable,
} from "../testing/persist-fixture.ts";

const WHOLE_FILE = ["PUT part 1", "PUT part 2", "PUT part 3", "PUT part 4", "POST /complete"];
const codeOf = (outcome: FileOutcome<unknown> | undefined) =>
  outcome?.status === "done" ? "done" : outcome?.error.code;

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A page of the owner "u1", whose quota fits the four-part file once, with a fake IndexedDB and fake Web Locks. */
function ownedPage(fault: Fault) {
  const db = fakeIndexedDb();
  const locks = fakeLocks();
  vi.stubGlobal("indexedDB", db.indexedDB);
  vi.stubGlobal("navigator", { locks: locks.locks });
  const store = memoryStore();
  const owned = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone }, { owner: () => "u1" });
  // Two reservations of the file never fit together.
  const fixture = clientFixture({ owned }, { store, quota: () => FOUR_PARTS + 1000, multipartThreshold: "8MB", fault });
  // One PUT at a time, so the order of requests is fixed.
  const client = () => createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, concurrency: 1 });
  return {
    fixture,
    store,
    db,
    locks,
    client,
    /** Resolves once the upload's record is saved: its lock taken and the file's edges hashed. */
    async saved() {
      while (Object.keys(db.stored()).length === 0) await db.settled();
    },
    /** The requests sent from now on. */
    from() {
      const start = fixture.requests.length;
      return () => fixture.requests.slice(start);
    },
    /** Each row's status, oldest first. */
    rows: async () =>
      (await store.raw.files()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((row) => row.status),
  };
}

/** The page before the reload is interrupted with parts 1 and 2 in the bucket; the new client lists that upload. */
async function reloadedWithQuota() {
  const held = gate(partThree);
  const page = ownedPage(held.fault);
  page.client().start("owned", fourParts());
  await held.reached;
  await page.saved();
  page.locks.releaseAll();
  const client = page.client();
  const [upload] = (await client.resumable()).data ?? [];
  if (!upload) throw new Error("The page before the reload left no record.");
  return { ...page, client, upload, sent: page.from() };
}

describe("a resumed upload that starts over, for an owner whose quota fits the file once (M11-R90)", () => {
  it("gives the ticket that can no longer sign its missing parts up first (M9-H3)", async () => {
    const setup = await reloadedWithQuota();
    vi.useFakeTimers({ toFake: ["Date"] });
    // In the ticket's last 15 minutes the server signs no URL; the row is still pending.
    vi.setSystemTime(Date.parse(setup.upload.expiresAt) - 14 * 60_000);
    const { data } = await setup.client.resume(setup.upload, fourParts()).done;

    expect({ sent: setup.sent(), outcome: codeOf(data?.files[0]), rows: await setup.rows() }).toEqual({
      sent: ["POST /complete", "POST /abort", "POST /upload", ...WHOLE_FILE],
      outcome: "done",
      rows: ["aborted", "completed"],
    });
  });

  it("gives the ticket of an upload the bucket lost up first", async () => {
    const setup = await reloadedWithQuota();
    const [row] = await setup.store.raw.files();
    // The bucket's lifecycle rule aborted the multipart upload. The server ends the row when /complete finds that out
    // (M11-R200), so the /abort that follows has nothing left to free.
    await setup.fixture.server.storage.abortMultipart(row?.key ?? "", row?.uploadId ?? "");
    const { data } = await setup.client.resume(setup.upload, fourParts()).done;

    expect({ sent: setup.sent(), outcome: codeOf(data?.files[0]), rows: await setup.rows() }).toEqual({
      sent: ["POST /complete", "POST /abort", "POST /upload", ...WHOLE_FILE],
      outcome: "done",
      rows: ["rejected", "completed"],
    });
  });
});

describe("a resumed upload that starts over after a /complete that may have finished it", () => {
  it("sends no /abort: the first probe got no answer, the second was answered UPLOAD_EXPIRED", async () => {
    const probes = [unreachable, () => serverError(410, "UPLOAD_EXPIRED", "This upload has expired.")];
    const setup = await reloaded(gate(partThree), (call: FaultCall) =>
      call.label === "POST /complete" ? probes[call.nth - 1]?.() : undefined,
    );
    const { data } = await setup.client.resume(setup.upload, fourParts()).done;
    await setup.drained();

    expect({ sent: setup.sent(), outcome: codeOf(data?.files[0]) }).toEqual({
      sent: ["POST /complete", "POST /complete", "POST /upload", ...WHOLE_FILE],
      outcome: "done",
    });
  });
});

describe("a retry after pagehide kept the failed file's ticket for a resume (M11-R91)", () => {
  /** Part 3 got no answer on any attempt, then the page hid: the record stays and the lock is let go (M4-F1). */
  async function hiddenThenRestored() {
    const events = pageEvents();
    let offline = true;
    const page = ownedPage((call) => (offline && call.label === "PUT part 3" ? unreachable() : undefined));
    const job = page.client().start("owned", fourParts());
    await job.done;
    await page.saved();
    events.fire("pagehide");
    await page.db.settled();
    offline = false;
    return { ...page, job, sent: page.from() };
  }

  it("discards the kept upload first, so its bytes no longer count against the quota", async () => {
    const page = await hiddenThenRestored();
    const outcome = await page.job.files[0]?.retry();
    await page.db.settled();

    expect({
      sent: page.sent(),
      outcome: codeOf(outcome),
      rows: await page.rows(),
      records: page.db.stored(),
    }).toEqual({
      sent: ["POST /abort", "POST /upload", ...WHOLE_FILE],
      outcome: "done",
      rows: ["aborted", "completed"],
      records: {},
    });
  });

  it("leaves the kept upload alone while another tab resumes it", async () => {
    const page = await hiddenThenRestored();
    const [id] = Object.keys(page.db.stored());
    page.locks.holdElsewhere(lockOf(id));
    const outcome = await page.job.files[0]?.retry();
    await page.db.settled();

    expect({ sent: page.sent(), outcome: codeOf(outcome), records: Object.keys(page.db.stored()) }).toEqual({
      // The other tab's upload still holds the owner's bytes.
      sent: ["POST /upload"],
      outcome: "QUOTA_EXCEEDED",
      records: [id],
    });
  });
});
