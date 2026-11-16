// Contract: decisions S11 (a URL with under 60 s left is renewed before use; after an opaque or expired answer a part's
// URL is renewed once; a renewed URL refused as expired fails the file) and S12 (at most 4 parts in flight; unsigned
// parts are signed lazily, up to 20 per /sign; the first part that fails for good stops new parts). Oracle: spec §5.2
// (batches of 20), §6.1 (4 in flight) and §6.2, worked by hand on the doubles below.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { SignedPart } from "../protocol/types.ts";
import type { BucketOutcome } from "./bucket.ts";
import {
  aborted,
  bucketUnreachable,
  linkRefused,
  signatureMismatch,
  storageDown,
  unreadableAnswer,
} from "./failures.ts";
import { nextStep, type PartSender, sendParts } from "./parts.ts";
import { waitAtLeast } from "./retry.ts";

const HOUR_MS = 3_600_000;

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A part URL; `url` says where it came from ("ticket" or "renewed"), so the log shows which one a PUT used. */
const signed = (partNumber: number, url: string, expiresAt = new Date(Date.now() + HOUR_MS)): SignedPart => ({
  partNumber,
  url,
  headers: {},
  expiresAt: expiresAt.toISOString(),
});

const stored: BucketOutcome = { kind: "stored" };
const opaque = (): BucketOutcome => ({ kind: "opaque", error: bucketUnreachable(), retryAfterMs: 0 });

interface DoubleOptions {
  first: SignedPart[];
  /** The answer to the `nth` PUT of `partNumber` to `url`, decided when it starts; stored by default. */
  put?: (partNumber: number, nth: number, url: string) => BucketOutcome;
  /** The answer to a /sign call; by default a fresh URL for each asked part. */
  sign?: (partNumbers: readonly number[]) => Result<SignedPart[]>;
  signal?: AbortSignal;
}

/** A PartSender whose calls each answer one microtask after they start, recording what was asked. */
function double({ first, put = () => stored, sign, signal = new AbortController().signal }: DoubleOptions) {
  const log = { calls: [] as string[], puts: [] as number[], signs: [] as number[][], peak: 0 };
  const attempts = new Map<number, number>();
  let inFlight = 0;
  const sender: PartSender = {
    signal,
    first,
    async sign(partNumbers) {
      log.calls.push(`sign ${partNumbers.join(",")}`);
      log.signs.push([...partNumbers]);
      await Promise.resolve();
      return sign ? sign(partNumbers) : ok(partNumbers.map((n) => signed(n, "renewed")));
    },
    async put(target, partNumber) {
      const nth = (attempts.get(partNumber) ?? 0) + 1;
      attempts.set(partNumber, nth);
      log.calls.push(`put ${partNumber} via ${target.url}`);
      log.puts.push(partNumber);
      const outcome = put(partNumber, nth, target.url);
      inFlight++;
      log.peak = Math.max(log.peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return outcome;
    },
  };
  return { sender, log };
}

const ascending = (numbers: number[]) => [...numbers].sort((a, b) => a - b);

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sendParts", () => {
  it("signs the parts the ticket did not cover in batches of 20", async () => {
    const { sender, log } = double({ first: range(1, 20).map((n) => signed(n, "ticket")) });
    const result = await sendParts(sender, range(1, 45));
    expect({ result, signs: log.signs, puts: ascending(log.puts), peak: log.peak }).toEqual({
      result: ok(undefined),
      signs: [range(21, 40), range(41, 45)],
      puts: range(1, 45),
      peak: 4,
    });
  });

  it("renews a URL that expires within a minute before using it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const { sender, log } = double({
      first: [signed(1, "ticket", new Date(now + 30_000)), signed(2, "ticket", new Date(now + 61_000))],
    });
    await sendParts(sender, [1, 2]);
    expect({ signs: log.signs, puts: log.calls.filter((call) => call.startsWith("put")).sort() }).toEqual({
      signs: [[1]],
      puts: ["put 1 via renewed", "put 2 via ticket"],
    });
  });

  it("renews once after an opaque failure, then waits and retries", async () => {
    // The R2 path no local backend produces: an expired URL answered without CORS headers (S10).
    const { sender, log } = double({
      first: [signed(1, "ticket")],
      put: (_, nth) => (nth === 1 ? opaque() : stored),
    });
    const result = await sendParts(sender, [1]);
    expect({ result, calls: log.calls }).toEqual({
      result: ok(undefined),
      calls: ["put 1 via ticket", "sign 1", "put 1 via renewed"],
    });
  });

  it("renews only once per part", async () => {
    const { sender, log } = double({
      first: [signed(1, "ticket")],
      put: (_, nth) => (nth < 3 ? opaque() : stored),
    });
    const result = await sendParts(sender, [1]);
    expect({ result, signs: log.signs }).toEqual({ result: ok(undefined), signs: [[1]] });
  });

  it("renews again when the renewal /sign fails", async () => {
    // A transient /sign failure must not use up the part's one renewal: the next attempt would reuse the refused URL.
    let calls = 0;
    const { sender, log } = double({
      first: [signed(1, "ticket")],
      put: (_, __, url) => (url === "ticket" ? { kind: "expired", error: linkRefused(), retryAfterMs: 0 } : stored),
      sign: (partNumbers) =>
        ++calls === 1
          ? fail(new CloudropError("SERVER_ERROR", "Try again.", { retryable: true }))
          : ok(partNumbers.map((n) => signed(n, "renewed"))),
    });
    const result = await sendParts(sender, [1]);
    expect({ result, calls: log.calls }).toEqual({
      result: ok(undefined),
      calls: ["put 1 via ticket", "sign 1", "sign 1", "put 1 via renewed"],
    });
  });

  it("waits for a /sign answer's Retry-After before signing again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    const { sender, log } = double({
      first: range(1, 20).map((n) => signed(n, "ticket")),
      sign: (partNumbers) =>
        ++calls === 1
          ? fail(waitAtLeast(new CloudropError("SERVER_ERROR", "Try again.", { retryable: true }), 2000))
          : ok(partNumbers.map((n) => signed(n, "renewed"))),
    });
    const result = sendParts(sender, range(1, 21));
    await vi.advanceTimersByTimeAsync(1999);
    const before = log.calls.includes("put 21 via renewed");
    await vi.advanceTimersByTimeAsync(1);
    expect({ before, after: log.calls.includes("put 21 via renewed"), result: await result }).toEqual({
      before: false,
      after: true,
      result: ok(undefined),
    });
  });

  it("fails a part a /sign answer keeps leaving out", async () => {
    // answers.ts refuses such an answer; this guards the loop in case a sign() ever skips that check.
    const { sender, log } = double({ first: [], sign: () => ok([]) });
    const result = await sendParts(sender, [1]);
    expect({ result, signs: log.signs }).toEqual({ result: fail(unreadableAnswer(200)), signs: [[1], [1]] });
  });

  it("stops starting parts after one fails for good, and lets the others finish", async () => {
    // Guards `failure ??= await sendPart(…)`: it reads `failure` before the await, so part 5's success, assigned after
    // it, would overwrite part 2's failure and the call would succeed.
    const { sender, log } = double({
      first: range(1, 10).map((n) => signed(n, "ticket")),
      put: (partNumber) => (partNumber === 2 ? { kind: "rejected", error: signatureMismatch() } : stored),
    });
    const { error } = await sendParts(sender, range(1, 10));
    const puts = ascending(log.puts);
    // Part 5 may or may not start before part 2's answer arrives: that follows microtask order, not the contract.
    expect({ code: error?.code, firstFour: puts.slice(0, 4), afterFive: puts.filter((n) => n > 5) }).toEqual({
      code: "UPLOAD_REJECTED",
      firstFour: [1, 2, 3, 4],
      afterFive: [],
    });
  });

  it("gives up on a part after 6 attempts", async () => {
    const { sender, log } = double({
      first: [signed(1, "ticket")],
      put: () => ({ kind: "retry", error: storageDown(), retryAfterMs: 0 }),
    });
    const { error } = await sendParts(sender, [1]);
    expect({ code: error?.code, retryable: error?.retryable, puts: log.puts }).toEqual({
      code: "STORAGE_ERROR",
      retryable: true,
      puts: [1, 1, 1, 1, 1, 1],
    });
  });

  it("fails with a /sign error that cannot be retried", async () => {
    const expired = new CloudropError("UPLOAD_EXPIRED", "This upload expired. Start it again to upload the file.");
    const { sender, log } = double({ first: range(1, 20).map((n) => signed(n, "ticket")), sign: () => fail(expired) });
    const result = await sendParts(sender, range(1, 21));
    expect({ result, signs: log.signs, puts: ascending(log.puts) }).toEqual({
      result: fail(expired),
      signs: [[21]],
      puts: range(1, 20),
    });
  });

  it("stops when the upload is cancelled", async () => {
    const controller = new AbortController();
    const { sender, log } = double({
      // Parts 5 and 6 have no URL yet, so a /sign after the cancel would show in the log.
      first: range(1, 4).map((n) => signed(n, "ticket")),
      signal: controller.signal,
      put: () => {
        controller.abort();
        return { kind: "aborted", error: aborted() };
      },
    });
    const { error } = await sendParts(sender, range(1, 6));
    expect({ code: error?.code, calls: log.calls }).toEqual({ code: "ABORTED", calls: ["put 1 via ticket"] });
  });
});

describe("nextStep", () => {
  it("retries a readable expiry at once with a new URL", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const expired: BucketOutcome = { kind: "expired", error: linkRefused(), retryAfterMs: 0 };
    expect(nextStep(expired, 1, false)).toEqual({ kind: "again", renew: true, waitMs: 0 });
  });

  it("waits before retrying an opaque failure with a new URL", () => {
    // Often a network outage: retrying at once would spend the budget before the connection is back.
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(nextStep(opaque(), 1, false)).toEqual({ kind: "again", renew: true, waitMs: 500 });
  });

  it("fails a part whose renewed URL is refused as expired", () => {
    const expired: BucketOutcome = { kind: "expired", error: linkRefused(), retryAfterMs: 0 };
    expect(nextStep(expired, 2, true)).toEqual({ kind: "fail", error: linkRefused() });
  });
});
