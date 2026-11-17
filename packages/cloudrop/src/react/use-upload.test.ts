// @vitest-environment happy-dom
// Contract: spec §6.1 (M4-B2, M4-B4) through createUploadHooks on the real client and the fake server. `files` lists
// every file of the jobs the hook started, in start order, each with controls bound to it, and keeps a file's object
// until that file changes; `totals` and `isUploading` span those jobs; upload(null) starts nothing; upload() reads the
// latest options; the input clears after a pick; StrictMode duplicates nothing; unmounting leaves the jobs running.
// Oracle: the requests the fixture saw, the server's verdicts for the routes below and the statuses the client reports.

import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InferableCloudrop } from "../client.ts";
import { createUploadHooks, type UploadHooks } from "../react.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StandardSchema } from "../server/schema.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { firstOf, gate } from "../testing/persist-fixture.ts";
import type { UploadFile } from "./types.ts";

const tagged: StandardSchema<{ tag: string }> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as { tag: string } }) },
};
const routes = {
  notes: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }),
  tagged: route({
    accept: "text/plain",
    maxSize: 16,
    metadata: tagged,
    authorize: allowAnyone,
    onComplete: ({ metadata }) => metadata,
  }),
};

/** Hooks whose client is created from options on first use, as an app's are, on a fixture answered by `fault`. */
function setup(fault: Fault = () => undefined) {
  const fixture = clientFixture(routes, { fault });
  return { fixture, ...createUploadHooks({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false }) };
}

/** waitFor polls every 50 ms by default; these renders follow microtasks and 0 ms backoffs. */
const fast = { interval: 1 };
const note = (text: string, name: string) => new File([text], name, { type: "text/plain" });
/** Holds the single PUT of the file of `size` bytes: sizes 5, 6 and 7 tell the files apart. */
const holdPut = (size: number) => gate((call) => call.label === "PUT object" && (call.init.body as Blob).size === size);
/** Every PUT of a file of `size` bytes fails while `failing.on`, through all its attempts: STORAGE_ERROR. */
function failPut(size: number) {
  const failing = { on: true };
  const fault: Fault = (call) =>
    failing.on && call.label === "PUT object" && (call.init.body as Blob).size === size
      ? errorResponse(500, "InternalError", "We encountered an internal error. Please try again.")
      : undefined;
  return { failing, fault };
}
const statuses = (files: readonly UploadFile<unknown>[]) => files.map((file) => `${file.name} ${file.status}`);
const count = (requests: string[], label: string) => requests.filter((request) => request === label).length;

/** A file input that takes several text files, and an output listing the hook's files. */
function Picker({ useUpload }: { useUpload: UploadHooks<InferableCloudrop>["useUpload"] }) {
  const { files, getInputProps } = useUpload("notes", { multiple: true, accept: "text/plain" });
  return createElement(
    "div",
    null,
    createElement("input", { ...getInputProps(), "aria-label": "Files" }),
    createElement("output", null, statuses(files).join(", ")),
  );
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useUpload", () => {
  it("lists every file of the hook's uploads in start order, with totals that leave failed files out", async () => {
    const { useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes", { multiple: true }));
    await act(() => result.current.upload(note("alpha", "a.txt")));
    // 20 bytes is over the route's 16: /upload refuses that file only.
    await act(() => result.current.upload([note("bravo!", "b.txt"), note("x".repeat(20), "big.txt")]));

    const { files, totals, isUploading } = result.current;
    expect({ files: statuses(files), code: files[2]?.error?.code, totals, isUploading }).toEqual({
      files: ["a.txt done", "b.txt done", "big.txt failed"],
      code: "FILE_TOO_LARGE",
      totals: { bytes: 11, size: 11, progress: 1, speed: 0, eta: null, done: 2, failed: 1, aborted: 0, count: 3 },
      isUploading: false,
    });
  });

  it("counts the hook as finished when its only counted file is an empty one that is done", async () => {
    const { useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes"));
    await act(() => result.current.upload(note("", "empty.txt")));
    await act(() => result.current.upload(note("x".repeat(20), "big.txt")));

    expect(result.current.totals).toEqual({
      bytes: 0,
      size: 0,
      progress: 1,
      speed: 0,
      eta: null,
      done: 1,
      failed: 1,
      aborted: 0,
      count: 2,
    });
  });

  it("is uploading while a file waits or sends, and not once it is paused or settled", async () => {
    const held = holdPut(5);
    const { useUpload } = setup(held.fault);
    const { result } = renderHook(() => useUpload("notes"));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.upload(note("alpha", "a.txt"));
    });
    const waiting = result.current.isUploading;
    await act(() => held.reached);
    const sending = result.current.isUploading;
    act(() => result.current.pause());
    await waitFor(() => expect(statuses(result.current.files)).toEqual(["a.txt paused"]), fast);
    const paused = result.current.isUploading;
    act(() => {
      result.current.resume();
      held.open();
    });
    await act(() => done);

    expect({ waiting, sending, paused, settled: result.current.isUploading }).toEqual({
      waiting: true,
      sending: true,
      paused: false,
      settled: false,
    });
  });

  it("resolves null for no file or an empty list, and sends nothing", async () => {
    const { fixture, useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes"));
    const answers = await act(() => Promise.all([result.current.upload(null), result.current.upload([])]));

    expect({ answers, files: result.current.files, requests: fixture.requests }).toEqual({
      answers: [null, null],
      files: [],
      requests: [],
    });
  });

  it("keeps a file's object while only another file changes, and replaces it when that file changes", async () => {
    const held = holdPut(6);
    const { useUpload } = setup(held.fault);
    const { result } = renderHook(() => useUpload("notes", { multiple: true }));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.upload([note("alpha", "a.txt"), note("bravo!", "b.txt")]);
    });
    await act(() => held.reached);
    await waitFor(() => expect(statuses(result.current.files)).toEqual(["a.txt done", "b.txt uploading"]), fast);
    const [first, second] = result.current.files;
    act(() => held.open());
    await act(() => done);

    const [firstAfter, secondAfter] = result.current.files;
    expect({ first: firstAfter === first, second: secondAfter === second, status: secondAfter?.status }).toEqual({
      first: true,
      second: false,
      status: "done",
    });
  });

  it("binds each file's pause, resume, abort and retry to that file", async () => {
    const held = holdPut(5);
    const broken = failPut(6);
    const { useUpload } = setup(firstOf(held.fault, broken.fault));
    const { result } = renderHook(() => useUpload("notes", { multiple: true }));
    act(() => {
      void result.current.upload([note("alpha", "a.txt"), note("bravo!", "b.txt")]);
    });
    await waitFor(() => expect(statuses(result.current.files)).toEqual(["a.txt uploading", "b.txt failed"]), fast);
    const steps: string[][] = [];
    /** Runs `action` on the files of the latest render, then waits for `expected` and records it. */
    const step = async (action: (files: readonly UploadFile<unknown>[]) => unknown, expected: string[]) => {
      act(() => void action(result.current.files));
      await waitFor(() => expect(statuses(result.current.files)).toEqual(expected), fast);
      steps.push(statuses(result.current.files));
    };

    broken.failing.on = false;
    await step(([, b]) => b?.retry(), ["a.txt uploading", "b.txt done"]);
    await step(([a]) => a?.pause(), ["a.txt paused", "b.txt done"]);
    // The gate holds the resumed PUT too.
    await step(([a]) => a?.resume(), ["a.txt uploading", "b.txt done"]);
    await step(([a]) => a?.abort(), ["a.txt aborted", "b.txt done"]);

    expect(steps).toEqual([
      ["a.txt uploading", "b.txt done"],
      ["a.txt paused", "b.txt done"],
      ["a.txt uploading", "b.txt done"],
      ["a.txt aborted", "b.txt done"],
    ]);
  });

  it("pauses, resumes and aborts every job of the hook", async () => {
    const held = gate((call) => call.label === "PUT object" && (call.init.body as Blob).size < 7);
    const broken = failPut(7);
    const { useUpload } = setup(firstOf(held.fault, broken.fault));
    const { result } = renderHook(() => useUpload("notes"));
    act(() => {
      void result.current.upload(note("alpha", "a.txt"));
      void result.current.upload(note("bravo!", "b.txt"));
      void result.current.upload(note("charlie", "c.txt"));
    });
    const seen: string[][] = [];
    const settle = async (expected: string[]) => {
      await waitFor(() => expect(statuses(result.current.files)).toEqual(expected), fast);
      seen.push(statuses(result.current.files));
    };
    await settle(["a.txt uploading", "b.txt uploading", "c.txt failed"]);
    act(() => result.current.pause());
    await settle(["a.txt paused", "b.txt paused", "c.txt failed"]);
    act(() => result.current.resume());
    await settle(["a.txt uploading", "b.txt uploading", "c.txt failed"]);
    act(() => result.current.abort());
    await settle(["a.txt aborted", "b.txt aborted", "c.txt aborted"]);

    expect(seen).toEqual([
      ["a.txt uploading", "b.txt uploading", "c.txt failed"],
      ["a.txt paused", "b.txt paused", "c.txt failed"],
      ["a.txt uploading", "b.txt uploading", "c.txt failed"],
      // A failed file ends aborted too (FileHandle.abort).
      ["a.txt aborted", "b.txt aborted", "c.txt aborted"],
    ]);
  });

  it("retries the failed files of every job of the hook", async () => {
    const broken = failPut(5);
    const { useUpload } = setup(broken.fault);
    const { result } = renderHook(() => useUpload("notes"));
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await act(() => result.current.upload(note("other", "b.txt")));
    broken.failing.on = false;
    await act(() => result.current.retry());

    expect(statuses(result.current.files)).toEqual(["a.txt done", "b.txt done"]);
  });

  it("clear() drops the settled jobs and keeps the running one", async () => {
    const held = holdPut(7);
    const { useUpload } = setup(held.fault);
    const { result } = renderHook(() => useUpload("notes"));
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await act(() => result.current.upload(note("x".repeat(20), "big.txt")));
    let running: Promise<unknown> = Promise.resolve();
    act(() => {
      running = result.current.upload(note("charlie", "c.txt"));
    });
    await act(() => held.reached);
    act(() => result.current.clear());
    const cleared = statuses(result.current.files);
    act(() => held.open());
    await act(() => running);

    expect({ cleared, after: statuses(result.current.files) }).toEqual({
      cleared: ["c.txt uploading"],
      after: ["c.txt done"],
    });
  });

  it("sends the latest render's metadata, unless the call passes its own", async () => {
    const { useUpload } = setup();
    const { result, rerender } = renderHook(({ tag }) => useUpload("tagged", { metadata: { tag } }), {
      initialProps: { tag: "first" },
    });
    rerender({ tag: "second" });
    const fromHook = await act(() => result.current.upload(note("alpha", "a.txt")));
    const fromCall = await act(() => result.current.upload(note("bravo", "b.txt"), { metadata: { tag: "call" } }));

    const dataOf = (answer: typeof fromHook) =>
      answer?.data?.files[0]?.status === "done" ? answer.data.files[0].result.data : null;
    expect([dataOf(fromHook), dataOf(fromCall)]).toEqual([{ tag: "second" }, { tag: "call" }]);
  });

  it("uploads what the input picked and clears it, so that picking the same file again uploads it again", async () => {
    const { fixture, useUpload } = setup();
    const view = render(createElement(Picker, { useUpload }));
    const input = view.getByLabelText("Files") as HTMLInputElement;
    const file = note("alpha", "a.txt");
    const pick = () => {
      const picked = new DataTransfer();
      picked.items.add(file);
      input.files = picked.files;
      fireEvent.change(input);
      return input.value;
    };

    const values = [pick()];
    await waitFor(() => expect(view.container.querySelector("output")?.textContent).toBe("a.txt done"), fast);
    values.push(pick());
    await waitFor(
      () => expect(view.container.querySelector("output")?.textContent).toBe("a.txt done, a.txt done"),
      fast,
    );

    expect({
      attributes: [input.type, input.multiple, input.accept],
      values,
      uploads: count(fixture.requests, "POST /upload"),
    }).toEqual({ attributes: ["file", true, "text/plain"], values: ["", ""], uploads: 2 });
  });

  it("sends one /upload for one upload() under StrictMode, and lists the file once", async () => {
    const { fixture, useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes"), { wrapper: StrictMode });
    await act(() => result.current.upload(note("alpha", "a.txt")));

    expect({ requests: fixture.requests, files: statuses(result.current.files) }).toEqual({
      requests: ["POST /upload", "PUT object", "POST /complete"],
      files: ["a.txt done"],
    });
  });

  it("leaves the upload running when the component unmounts, and sends no /abort", async () => {
    const held = holdPut(5);
    const { fixture, useUpload } = setup(held.fault);
    const { result, unmount } = renderHook(() => useUpload("notes"));
    let done: ReturnType<typeof result.current.upload> = Promise.resolve(null);
    act(() => {
      done = result.current.upload(note("alpha", "a.txt"));
    });
    await held.reached;
    unmount();
    held.open();
    const answer = await done;

    expect({ status: answer?.data?.files[0]?.status, requests: fixture.requests }).toEqual({
      status: "done",
      requests: ["POST /upload", "PUT object", "POST /complete"],
    });
  });
});
