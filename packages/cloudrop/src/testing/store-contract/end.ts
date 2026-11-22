// end, revoke and cleaned: rows reaching an ended status release exactly the bytes their previous status held.

import { expect, it } from "vitest";
import type { EndedStatus, FileRecordStatus } from "../../server/store.ts";
import type { RawFileRow } from "../store-rows.ts";
import { at, MINUTE, newFile, pendingRow, type StoreSuite, usageRow } from "./suite.ts";

export function endCases(suite: StoreSuite): void {
  const { rawFile, seed, advance } = suite;

  it.each<{ from: FileRecordStatus; to: EndedStatus; cleaned: boolean; claimed: Partial<RawFileRow> }>([
    { from: "pending", to: "aborted", cleaned: false, claimed: {} },
    { from: "completing", to: "failed", cleaned: true, claimed: { claim: "claim-f-1", claimedAt: at(MINUTE) } },
  ])(
    "end from $from to $to releases the reserved bytes (cleaned: $cleaned)",
    async ({ from, to, cleaned, claimed }) => {
      const { store, raw } = suite;
      await seed("u-1", [newFile("f-1", 100), newFile("f-2", 30)]);
      await advance("f-1", from, at(MINUTE));
      const ended = await store.end("f-1", from, to, at(2 * MINUTE), { cleaned });
      expect(ended).toEqual({ changed: true, record: await store.get("f-1") });
      // The claim fields stay as they were (M5-T17).
      expect(await rawFile("f-1")).toEqual(
        pendingRow(newFile("f-1", 100), "u-1", {
          ...claimed,
          status: to,
          endedAt: at(2 * MINUTE),
          cleanedAt: cleaned ? at(2 * MINUTE) : null,
          updatedAt: at(2 * MINUTE),
        }),
      );
      expect(await raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 30, updatedAt: at(2 * MINUTE) })]);
    },
  );

  it("end from completed to deleted releases the active bytes and the file", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 100), newFile("f-2", 30)]);
    await advance("f-1", "completed", at(MINUTE));
    await advance("f-2", "completed", at(MINUTE));
    expect((await store.end("f-1", "completed", "deleted", at(2 * MINUTE))).changed).toBe(true);
    expect(await rawFile("f-1")).toEqual(
      pendingRow(newFile("f-1", 100), "u-1", {
        status: "deleted",
        claim: "claim-f-1",
        claimedAt: at(MINUTE),
        completedAt: at(MINUTE),
        endedAt: at(2 * MINUTE),
        updatedAt: at(2 * MINUTE),
      }),
    );
    expect(await raw.usage()).toEqual([usageRow("u-1", { activeBytes: 30, files: 1, updatedAt: at(2 * MINUTE) })]);
  });

  it("end leaves a row in another status as it is and answers it, and answers null for a missing row", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 100), newFile("f-2", 30)]);
    await advance("f-1", "completed", at(MINUTE));
    await advance("f-2", "aborted", at(MINUTE));
    const before = { files: await raw.files(), usage: await raw.usage() };
    // An /abort after the completion, and an /abort repeated after the first.
    expect(await store.end("f-1", "pending", "aborted", at(2 * MINUTE))).toEqual({
      changed: false,
      record: await store.get("f-1"),
    });
    expect(await store.end("f-2", "pending", "aborted", at(2 * MINUTE))).toEqual({
      changed: false,
      record: await store.get("f-2"),
    });
    expect({ files: await raw.files(), usage: await raw.usage() }).toEqual(before);
    expect(await store.end("missing", "pending", "aborted", at(2 * MINUTE))).toEqual({ changed: false, record: null });
  });

  it("end from an ended status moves the row and releases nothing", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 100), newFile("f-2", 30)]);
    await advance("f-1", "aborted", at(MINUTE));
    const usage = await raw.usage();
    expect((await store.end("f-1", "aborted", "expired", at(2 * MINUTE), { cleaned: true })).changed).toBe(true);
    expect((await rawFile("f-1"))?.status).toBe("expired");
    expect(await raw.usage()).toEqual(usage);
    expect(usage).toEqual([usageRow("u-1", { reservedBytes: 30, updatedAt: at(MINUTE) })]);
  });

  it("revoke aborts only the owner's pending rows and releases only their reservations", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 1), newFile("f-2", 2), newFile("f-3", 4), newFile("f-4", 8)]);
    await seed("u-2", [newFile("f-5", 16)]);
    await advance("f-3", "completing", at(MINUTE));
    await advance("f-4", "completed", at(MINUTE));
    expect(await store.revoke("u-1", at(2 * MINUTE))).toBe(2);
    const revoked = { status: "aborted", endedAt: at(2 * MINUTE), updatedAt: at(2 * MINUTE) } as const;
    const claimedAt = at(MINUTE);
    expect(await raw.files()).toEqual([
      pendingRow(newFile("f-1", 1), "u-1", revoked),
      pendingRow(newFile("f-2", 2), "u-1", revoked),
      pendingRow(newFile("f-3", 4), "u-1", {
        status: "completing",
        claim: "claim-f-3",
        claimedAt,
        updatedAt: claimedAt,
      }),
      pendingRow(newFile("f-4", 8), "u-1", {
        status: "completed",
        claim: "claim-f-4",
        claimedAt,
        completedAt: claimedAt,
        updatedAt: claimedAt,
      }),
      pendingRow(newFile("f-5", 16), "u-2"),
    ]);
    expect(await raw.usage()).toEqual([
      usageRow("u-1", { reservedBytes: 4, activeBytes: 8, files: 1, updatedAt: at(2 * MINUTE) }),
      usageRow("u-2", { reservedBytes: 16 }),
    ]);
    expect(await store.revoke("u-1", at(3 * MINUTE))).toBe(0);
  });

  it("cleaned stamps cleaned_at once and leaves a missing row alone", async () => {
    const { store } = suite;
    await seed("u-1", [newFile("f-1", 10)]);
    await advance("f-1", "aborted", at(MINUTE));
    await store.cleaned("f-1", at(2 * MINUTE));
    await store.cleaned("f-1", at(3 * MINUTE));
    expect(await rawFile("f-1")).toEqual(
      pendingRow(newFile("f-1", 10), "u-1", {
        status: "aborted",
        endedAt: at(MINUTE),
        cleanedAt: at(2 * MINUTE),
        updatedAt: at(2 * MINUTE),
      }),
    );
    await expect(store.cleaned("missing", at(2 * MINUTE))).resolves.toBeUndefined();
  });
}
