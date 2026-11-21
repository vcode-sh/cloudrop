// Contract: M11-R80 and M11-R81 on the real server, stateless and with a store. A retry() never sends again a request
// whose answer cannot change: after /complete refused the file's content and deleted it, the retry asks /upload for a
// new ticket; after /complete found no object (a proxy answered the PUT for the bucket), it sends the bytes again on
// the same ticket; and once /complete has answered that a ticket in doubt is over, the next retry leaves it.
// A retry that replaces a ticket gives the old one up first, as abort() of the failed file would (M11-R89), so what it
// reserved or stored does not stand in the new upload's way.
// Oracle: the requests each retry sent and the objects and open uploads the fake bucket holds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type FileOutcome } from "../client.ts";
import { contentChecks } from "../plugins/content-checks.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, lostPart, unfinished } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { JPEG } from "../testing/file-samples.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

/** A client on the fake bucket, with a store or without; `fault` answers requests while `state.failing`. */
function setup(stored: boolean, fault: Fault = () => undefined) {
  const state = { failing: true };
  const fixture = clientFixture(
    { files },
    {
      plugins: [contentChecks()],
      multipartThreshold: "8MB",
      store: stored ? memoryStore() : undefined,
      fault: (call) => (state.failing ? fault(call) : undefined),
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
  /** Runs `act` and answers the requests it sent. */
  const sentBy = async <T>(act: () => Promise<T>): Promise<{ answer: T; sent: string[] }> => {
    const start = fixture.requests.length;
    const answer = await act();
    return { answer, sent: fixture.requests.slice(start) };
  };
  /** The sizes of the objects the bucket holds. */
  const objects = async () => (await fixture.server.storage.list("")).data?.items.map((item) => item.size);
  return { fixture, state, client, sentBy, objects };
}

const bytes = (size = 1000) => new File([offsetBytes(size)], "a.bin", { type: "application/octet-stream" });
const codeOf = (outcome: FileOutcome<unknown> | undefined) =>
  outcome?.status === "done" ? "done" : outcome?.error.code;
const BACKENDS = [
  { name: "without a store", stored: false },
  { name: "with a store", stored: true },
];

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(BACKENDS)("retry $name", ({ stored }) => {
  it("asks /upload for a new ticket after /complete refused the file's content and deleted it", async () => {
    const { client, sentBy, objects } = setup(stored);
    // A JPEG sent as a PNG: contentChecks() refuses it at /complete, and the server deletes the object.
    const job = client.start("files", new File([JPEG], "photo.png", { type: "image/png" }));
    const first = await job.done;
    const { answer, sent } = await sentBy(async () => job.files[0]?.retry());

    expect({ first: first.error?.code, sent, again: codeOf(answer), objects: await objects() }).toEqual({
      first: "FILE_TYPE_NOT_ALLOWED",
      // The same bytes are refused again: the new upload reached /complete, which no old ticket could.
      sent: ["POST /abort", "POST /upload", "PUT object", "POST /complete"],
      again: "FILE_TYPE_NOT_ALLOWED",
      objects: [],
    });
  });

  it("sends the file again on the same ticket after a PUT was answered for the bucket and nothing was stored", async () => {
    const { state, client, sentBy, objects } = setup(stored, ({ label }) =>
      label === "PUT object" ? lostPart() : undefined,
    );
    const job = client.start("files", bytes());
    const first = await job.done;
    state.failing = false;
    const { answer, sent } = await sentBy(async () => job.files[0]?.retry());

    expect({ first: first.error?.code, sent, again: codeOf(answer), objects: await objects() }).toEqual({
      first: "NOT_UPLOADED",
      sent: ["PUT object", "POST /complete"],
      again: "done",
      objects: [1000],
    });
  });

  it("sends the file again once /complete, in doubt before, answered that nothing is stored", async () => {
    // Every /complete fails on the server, so the file may be complete; the PUT never reached the bucket.
    const { state, client, sentBy } = setup(stored, ({ label }) => {
      if (label === "PUT object") return lostPart();
      return label === "POST /complete" ? unfinished() : undefined;
    });
    const job = client.start("files", bytes());
    const first = await job.done;
    state.failing = false;
    const told = await sentBy(async () => job.files[0]?.retry());
    const resent = await sentBy(async () => job.files[0]?.retry());

    expect({
      first: first.error?.code,
      told: [told.sent, codeOf(told.answer)],
      resent: [resent.sent, codeOf(resent.answer)],
    }).toEqual({
      first: "SERVER_ERROR",
      told: [["POST /complete"], "NOT_UPLOADED"],
      resent: [["PUT object", "POST /complete"], "done"],
    });
  });

  it("leaves a ticket in doubt once /complete answered that it expired (M3-U30 amended)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let expiresAt = "";
    const { state, client, sentBy, objects } = setup(stored, async (call) => {
      if (call.label === "POST /upload") {
        const answer = await call.forward(call.init);
        expiresAt = (await answer.clone().json()).files[0].expiresAt;
        return answer;
      }
      // The object is stored; the server never hears of /complete, and the page hears nothing back.
      return call.label === "POST /complete" ? Promise.reject(new TypeError("Failed to fetch")) : undefined;
    });
    const job = client.start("files", bytes());
    const first = await job.done;
    state.failing = false;
    vi.setSystemTime(Date.parse(expiresAt) + 1000);
    const told = await sentBy(async () => job.files[0]?.retry());
    const started = await sentBy(async () => job.files[0]?.retry());

    expect({
      first: first.error?.code,
      told: [told.sent, codeOf(told.answer)],
      started: [started.sent, codeOf(started.answer)],
      objects: await objects(),
    }).toEqual({
      first: "NETWORK_ERROR",
      // Whatever the clock says, the server's word comes first (M3-U30).
      told: [["POST /complete"], "UPLOAD_EXPIRED"],
      started: [["POST /upload", "PUT object", "POST /complete"], "done"],
      // The first ticket's object stays: no /abort is sent for a ticket a /complete may have finished.
      objects: [1000, 1000],
    });
  });
});

describe("retry after PARTS_MISSING", () => {
  it("sends every part again when the answer names none", async () => {
    // A proxy answers every PUT of part 2 for the bucket, and strips `parts` from the server's PARTS_MISSING.
    const { state, client, sentBy } = setup(false, async (call) => {
      if (call.label === "PUT part 2") return lostPart();
      if (call.label !== "POST /complete") return undefined;
      const { error } = await (await call.forward(call.init)).json();
      return Response.json({ error: { ...error, parts: undefined } }, { status: 409 });
    });
    const job = client.start("files", bytes(8 * MiB + 5));
    const first = await job.done;
    state.failing = false;
    const { answer, sent } = await sentBy(async () => job.files[0]?.retry());

    expect({ first: first.error?.code, sent: sent.sort(), again: codeOf(answer) }).toEqual({
      first: "PARTS_MISSING",
      sent: ["POST /complete", "PUT part 1", "PUT part 2"],
      again: "done",
    });
  });
});

describe("retry with a new ticket, after the bucket refused the file", () => {
  const refusedPut =
    (label: string): Fault =>
    (call) =>
      call.label === label ? errorResponse(400, "BadRequest", "Refused.") : undefined;

  it("frees what the first ticket reserved, so an owner near their quota can retry", async () => {
    const owned = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }, { owner: () => "u1" });
    let failing = true;
    const fixture = clientFixture(
      { owned },
      // 600 of the owner's 1,000 bytes: two reservations of this file never fit together.
      {
        store: memoryStore(),
        quota: () => 1000,
        fault: (call) => (failing ? refusedPut("PUT object")(call) : undefined),
      },
    );
    const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
    const job = client.start("owned", bytes(600));
    const first = await job.done;
    failing = false;
    const before = fixture.requests.length;
    const outcome = await job.files[0]?.retry();

    expect([first.error?.code, fixture.requests.slice(before), codeOf(outcome)]).toEqual([
      "UPLOAD_REJECTED",
      ["POST /abort", "POST /upload", "PUT object", "POST /complete"],
      "done",
    ]);
  });

  it("aborts the first multipart upload, whose first part had landed", async () => {
    const { fixture, state, client, sentBy } = setup(false, refusedPut("PUT part 2"));
    const job = client.start("files", bytes(8 * MiB + 5));
    const first = await job.done;
    state.failing = false;
    const { answer, sent } = await sentBy(async () => job.files[0]?.retry());

    expect({
      first: first.error?.code,
      firstRequest: sent[0],
      again: codeOf(answer),
      openUploads: fixture.server.fake.pendingUploads(),
    }).toEqual({ first: "UPLOAD_REJECTED", firstRequest: "POST /abort", again: "done", openUploads: 0 });
  });
});
