// Contract: spec §2.2, §4.4 and §4.6 through the real client: start() sends every file through one /upload, runs each
// file on its own, and settles `done` once with an outcome per file in the order passed; `error` is the first file's
// that did not end done (M3-U3), carrying `error.file`, and `data` is null only when /upload refused the whole job.
// One file failing or being cancelled never stops another. Ids count across the jobs of one client (ruling M3-U2).
// Oracle: the server's verdicts for the routes below, the bytes the fake bucket stored, and the requests it saw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type FileOutcome } from "../client.ts";
import { allowAnyone, route, unauthorized } from "../server/route.ts";
import { clientFixture, type Fault, type FaultCall } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";

const notes = route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone });
const pairs = route({ accept: "text/plain", maxSize: 16, maxFiles: 2, authorize: allowAnyone });
const members = route({
  accept: "text/plain",
  maxSize: 16,
  authorize: ({ request }) => (request.headers.get("x-user") ? {} : unauthorized("Sign in to upload notes.")),
});

/**
 * `fault` answers every request but /abort, which is forwarded: its settling is kept in `seen.aborted`,
 * `seen.abortsAnswered` counts the answers that arrived and `seen.abortTokens` holds the tokens sent.
 */
function setup(fault: Fault = () => undefined) {
  const seen = { aborted: Promise.resolve(), abortsAnswered: 0, abortTokens: [] as string[] };
  const fixture = clientFixture(
    { notes, pairs, members },
    {
      fault: (call) => {
        if (call.label !== "POST /abort") return fault(call);
        seen.abortTokens.push(JSON.parse(call.init.body as string).token);
        const answer = call.forward(call.init).then((response) => {
          seen.abortsAnswered++;
          return response;
        });
        seen.aborted = answer.then(() => undefined);
        return answer;
      },
    },
  );
  return { fixture, seen, client: createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch }) };
}

const note = (text: string, name: string) => new File([text], name, { type: "text/plain" });
// Sizes 5, 6 and 7: a fault picks a file by its body's size, never by the order requests arrive.
const three = () => [note("alpha", "a.txt"), note("bravo!", "b.txt"), note("charlie", "c.txt")];
const bodySize = (init: RequestInit) => (init.body as Blob).size;

/** An outcome reduced to what the contract fixes: the error's code and file, or the stored file's name and size. */
const view = (outcome: FileOutcome<unknown>) =>
  outcome.status === "done"
    ? { id: outcome.id, status: outcome.status, file: [outcome.result.file.name, outcome.result.file.size] }
    : { id: outcome.id, status: outcome.status, code: outcome.error.code, file: outcome.error.file };

const count = (requests: string[], label: string) => requests.filter((request) => request === label).length;

/** /upload held until `release()`, then answered by `answer` (the server's own answer by default); `seen` on arrival. */
function heldUpload(answer: (call: FaultCall) => Promise<Response> = (call) => call.forward(call.init)) {
  let arrived = () => {};
  let release = () => {};
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fault: Fault = async (call) => {
    if (call.label !== "POST /upload") return undefined;
    arrived();
    await open;
    return answer(call);
  };
  return { seen, release, fault };
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("start", () => {
  it("sends three files through one /upload and settles with each file's result", async () => {
    const { fixture, client } = setup();
    const [a, b, c] = three();
    // An ArrayLike that is not an array, as input.files is.
    const { done } = client.start("notes", { 0: a, 1: b, 2: c, length: 3 } as ArrayLike<File>);
    const result = await done;
    const stored = await Promise.all(
      (result.data?.files ?? []).map(async (outcome) => {
        if (outcome.status !== "done") return null;
        const { data } = await fixture.server.storage.getRange(
          outcome.result.file.key,
          0,
          outcome.result.file.size - 1,
        );
        return new TextDecoder().decode(data ?? undefined);
      }),
    );
    const doneOutcome = (id: string, name: string, size: number) => ({
      id,
      name,
      status: "done",
      result: { file: expect.objectContaining({ name, size, type: "text/plain" }), data: null },
    });
    expect({ result, stored, requests: [...fixture.requests].sort() }).toEqual({
      result: {
        data: { files: [doneOutcome("1", "a.txt", 5), doneOutcome("2", "b.txt", 6), doneOutcome("3", "c.txt", 7)] },
        error: null,
      },
      stored: ["alpha", "bravo!", "charlie"],
      requests: [...Array(3).fill("POST /complete"), "POST /upload", ...Array(3).fill("PUT object")],
    });
  });

  it("uploads the other files when the route refuses one, and names that file in the error", async () => {
    const { fixture, client } = setup();
    const files = [note("alpha", "a.txt"), note("seventeen bytes!!", "big.txt"), note("charlie", "c.txt")];
    const { data, error } = await client.start("notes", files).done;
    expect({
      files: data?.files.map(view),
      error: { code: error?.code, file: error?.file },
      requests: count(fixture.requests, "POST /upload"),
    }).toEqual({
      files: [
        { id: "1", status: "done", file: ["a.txt", 5] },
        { id: "2", status: "failed", code: "FILE_TOO_LARGE", file: { id: "2", name: "big.txt" } },
        { id: "3", status: "done", file: ["c.txt", 7] },
      ],
      error: { code: "FILE_TOO_LARGE", file: { id: "2", name: "big.txt" } },
      requests: 1,
    });
  });

  it("fails only the file whose PUT the bucket refused, and sends no /abort: start() keeps its ticket", async () => {
    const { fixture, seen, client } = setup(({ label, init }) =>
      label === "PUT object" && bodySize(init) === 6 ? errorResponse(400, "BadRequest", "Rejected.") : undefined,
    );
    const { data, error } = await client.start("notes", three()).done;
    await seen.aborted;
    const kept = await Promise.all(
      [data?.files[0], data?.files[2]].map(async (outcome) =>
        outcome?.status === "done" ? (await fixture.server.storage.head(outcome.result.file.key)).data?.size : null,
      ),
    );
    expect({
      files: data?.files.map(view),
      error: { code: error?.code, file: error?.file },
      aborts: count(fixture.requests, "POST /abort"),
      kept,
    }).toEqual({
      files: [
        { id: "1", status: "done", file: ["a.txt", 5] },
        { id: "2", status: "failed", code: "UPLOAD_REJECTED", file: { id: "2", name: "b.txt" } },
        { id: "3", status: "done", file: ["c.txt", 7] },
      ],
      error: { code: "UPLOAD_REJECTED", file: { id: "2", name: "b.txt" } },
      aborts: 0,
      kept: [5, 7],
    });
  });

  it.each([
    { name: "authorize refuses", route: "members" as const, code: "UNAUTHORIZED" },
    { name: "the job has more files than maxFiles", route: "pairs" as const, code: "TOO_MANY_FILES" },
  ])("answers data null and sends nothing else when /upload refuses the whole job: $name", async (row) => {
    const { fixture, client } = setup();
    const { data, error } = await client.start(row.route, three()).done;
    expect({ data, code: error?.code, file: error?.file, requests: fixture.requests }).toEqual({
      data: null,
      code: row.code,
      file: undefined,
      requests: ["POST /upload"],
    });
  });

  it("aborts every file when the job's signal fires during the PUTs, and tells the server of each", async () => {
    const controller = new AbortController();
    const { seen, client } = setup(({ label }) => {
      if (label === "PUT object") controller.abort();
      return undefined;
    });
    const { data, error } = await client.start("notes", three(), { signal: controller.signal }).done;
    // Read the moment done settles: a cancel waits for the server's answer to its /abort.
    const abortsAnswered = seen.abortsAnswered;
    expect({ statuses: data?.files.map((outcome) => outcome.status), code: error?.code, abortsAnswered }).toEqual({
      statuses: ["aborted", "aborted", "aborted"],
      code: "ABORTED",
      abortsAnswered: 3,
    });
  });

  it("cancels one file while its PUT is held and uploads the others", async () => {
    let reached = () => {};
    const atPut = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = setup(async ({ label, init }) => {
      if (label !== "PUT object" || bodySize(init) !== 6) return undefined;
      reached();
      await held;
      return undefined;
    });
    const job = client.start("notes", three());
    await atPut;
    job.files[1]?.abort();
    release();
    const { data, error } = await job.done;
    expect({ files: data?.files.map(view), error: { code: error?.code, file: error?.file } }).toEqual({
      files: [
        { id: "1", status: "done", file: ["a.txt", 5] },
        { id: "2", status: "aborted", code: "ABORTED", file: { id: "2", name: "b.txt" } },
        { id: "3", status: "done", file: ["c.txt", 7] },
      ],
      error: { code: "ABORTED", file: { id: "2", name: "b.txt" } },
    });
  });

  it("cancels one file while /upload is in flight: the /abort goes for its ticket, the others upload", async () => {
    let tickets: string[] = [];
    const upload = heldUpload(async (call) => {
      const answer = await call.forward(call.init);
      tickets = (await answer.clone().json()).files.map((ticket: { token: string }) => ticket.token);
      return answer;
    });
    const { seen, client } = setup(upload.fault);
    const job = client.start("notes", three());
    await upload.seen;
    job.files[1]?.abort();
    upload.release();
    const { data, error } = await job.done;
    expect({
      files: data?.files.map(view),
      error: { code: error?.code, file: error?.file },
      aborted: seen.abortTokens,
    }).toEqual({
      files: [
        { id: "1", status: "done", file: ["a.txt", 5] },
        { id: "2", status: "aborted", code: "ABORTED", file: { id: "2", name: "b.txt" } },
        { id: "3", status: "done", file: ["c.txt", 7] },
      ],
      error: { code: "ABORTED", file: { id: "2", name: "b.txt" } },
      aborted: [tickets[1]],
    });
  });

  it("reports a file cancelled during an /upload that then fails as aborted, and keeps the job's error", async () => {
    const upload = heldUpload();
    // members refuses a request without x-user: /upload answers UNAUTHORIZED once released.
    const { client } = setup(upload.fault);
    const job = client.start("members", three());
    await upload.seen;
    job.files[1]?.abort();
    upload.release();
    const { data, error } = await job.done;
    expect({
      data,
      error: { code: error?.code, file: error?.file },
      files: job.getSnapshot().files.map((file) => [file.status, file.error?.code, file.error?.file]),
    }).toEqual({
      data: null,
      error: { code: "UNAUTHORIZED", file: undefined },
      files: [
        ["failed", "UNAUTHORIZED", undefined],
        ["aborted", "ABORTED", { id: "2", name: "b.txt" }],
        ["failed", "UNAUTHORIZED", undefined],
      ],
    });
  });

  it("counts file ids across the jobs of one client", async () => {
    const { client } = setup();
    const first = client.start("notes", three());
    const second = client.start("notes", note("delta", "d.txt"));
    await Promise.all([first.done, second.done]);
    expect([...first.files, ...second.files].map(({ id, name }) => [id, name])).toEqual([
      ["1", "a.txt"],
      ["2", "b.txt"],
      ["3", "c.txt"],
      ["4", "d.txt"],
    ]);
  });
});
