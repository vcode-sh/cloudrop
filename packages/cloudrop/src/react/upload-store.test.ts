// @vitest-environment happy-dom
// Contract: spec §6.1 (M4-B2, M4-B4, M4-B8, M4-B11) for what useUpload renders, through createUploadHooks on the real
// client and the fake server: `files` lists every file of the route's jobs in start order and keeps a file's object
// until that file changes; `totals` and `isUploading` span those jobs; clear() keeps failed and running jobs, for every
// component on the route; a hook hidden by <Activity> shows what its jobs did meanwhile; unmounting leaves the jobs
// running, and the next component on the route lists them; two components on one route share one list.
// Oracle: the server's verdicts for the route below, the requests the fixture saw and the statuses the client reports.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Activity, createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentChecks } from "../plugins/content-checks.ts";
import { createUploadHooks } from "../react.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { JPEG } from "../testing/file-samples.ts";
import { gate } from "../testing/persist-fixture.ts";
import { failPut, fast, holdPut, hooksFixture, note, statuses } from "../testing/react-fixture.ts";

const notes = route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone });
const setup = (fault?: Fault) => hooksFixture({ notes, photos: notes }, fault);
/** The mode of the test's <Activity> wrapper, read on every render. */
const visibility: { mode: "visible" | "hidden" } = { mode: "visible" };

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  visibility.mode = "visible";
  cleanup();
  vi.restoreAllMocks();
});

describe("what useUpload renders", () => {
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

  // M11-K5: a page words a type refusal itself from the failed file's `error.content`.
  it("gives a file contentChecks() refused its error with `content`, in `files` and in upload()'s result", async () => {
    const photos = route({ accept: "image/*", maxSize: "1MB", authorize: allowAnyone });
    const fixture = clientFixture({ photos }, { plugins: [contentChecks()] });
    const { useUpload } = createUploadHooks({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
    const { result } = renderHook(() => useUpload("photos"));
    const answer = await act(() => result.current.upload(new File([JPEG], "photo.png", { type: "image/png" })));
    const [file] = result.current.files;
    const content = { declared: "image/png", detected: "image/jpeg", reason: "mismatch" };

    expect({
      file: [file?.status, file?.error?.code, file?.error?.content],
      answer: [answer?.error?.code, answer?.error?.content],
    }).toEqual({
      file: ["failed", "FILE_TYPE_NOT_ALLOWED", content],
      answer: ["FILE_TYPE_NOT_ALLOWED", content],
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

  it("clear() drops the jobs whose files all ended done or aborted, and keeps failed and running ones", async () => {
    // Holds c.txt (7 bytes) and d.txt (8 bytes); d.txt is then cancelled.
    const held = gate((call) => call.label === "PUT object" && (call.init.body as Blob).size >= 7);
    const { useUpload } = setup(held.fault);
    const { result } = renderHook(() => useUpload("notes"));
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await act(() => result.current.upload(note("x".repeat(20), "big.txt")));
    let running: Promise<unknown> = Promise.resolve();
    act(() => {
      running = result.current.upload(note("charlie", "c.txt"));
      void result.current.upload(note("delta!!!", "d.txt"));
    });
    await waitFor(
      () => expect(statuses(result.current.files).slice(2)).toEqual(["c.txt uploading", "d.txt uploading"]),
      fast,
    );
    act(() => void result.current.files[3]?.abort());
    await waitFor(() => expect(result.current.files[3]?.status).toBe("aborted"), fast);
    act(() => result.current.clear());
    const cleared = statuses(result.current.files);
    act(() => held.open());
    await act(() => running);

    expect({ cleared, after: statuses(result.current.files) }).toEqual({
      // A failed file is kept: retry() can still send it, and the client still holds what it needs for that.
      cleared: ["big.txt failed", "c.txt uploading"],
      after: ["big.txt failed", "c.txt done"],
    });
  });

  it("shows what the jobs did while it was hidden by <Activity>, once it is shown again", async () => {
    const held = holdPut(5);
    const { useUpload } = setup(held.fault);
    const { result, rerender } = renderHook(() => useUpload("notes"), {
      wrapper: ({ children }) => createElement(Activity, { mode: visibility.mode, children }),
    });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.upload(note("alpha", "a.txt"));
    });
    await act(() => held.reached);
    // Hidden, the component keeps its state but React unsubscribes it from the store.
    visibility.mode = "hidden";
    rerender();
    held.open();
    await act(() => done);
    visibility.mode = "visible";
    rerender();

    expect(statuses(result.current.files)).toEqual(["a.txt done"]);
  });

  it("leaves the upload running when the component unmounts, and shows it to the next mount", async () => {
    const held = holdPut(5);
    const { fixture, useUpload } = setup(held.fault);
    const first = renderHook(() => useUpload("notes"));
    let done: ReturnType<typeof first.result.current.upload> = Promise.resolve(null);
    act(() => {
      done = first.result.current.upload(note("alpha", "a.txt"));
    });
    await held.reached;
    first.unmount();
    const { result } = renderHook(() => useUpload("notes"));
    const remounted = statuses(result.current.files);
    held.open();
    const answer = await act(() => done);

    expect({
      remounted,
      status: answer?.data?.files[0]?.status,
      after: statuses(result.current.files),
      requests: fixture.requests,
    }).toEqual({
      remounted: ["a.txt uploading"],
      status: "done",
      after: ["a.txt done"],
      requests: ["POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("lists a file that failed before an unmount to the next mount, whose retry() sends it", async () => {
    // The page navigated away and back without a reload: the client still holds the failed file's ticket, so
    // useResumable does not list it and resume() would refuse it; only this list reaches it (M4-B4).
    const broken = failPut(5);
    const { useUpload } = setup(broken.fault);
    const first = renderHook(() => useUpload("notes"));
    await act(() => first.result.current.upload(note("alpha", "a.txt")));
    first.unmount();
    const { result } = renderHook(() => useUpload("notes"));
    const remounted = statuses(result.current.files);
    broken.failing.on = false;
    const retried = await act(() => result.current.files[0]?.retry());

    expect({ remounted, retried: retried?.status, after: statuses(result.current.files) }).toEqual({
      remounted: ["a.txt failed"],
      retried: "done",
      after: ["a.txt done"],
    });
  });

  it("shares one list between the components on a route, under StrictMode, and keeps other routes apart", async () => {
    const { fixture, useUpload } = setup();
    const options = { wrapper: StrictMode };
    const sender = renderHook(() => useUpload("notes"), options);
    const reader = renderHook(() => useUpload("notes"), options);
    const other = renderHook(() => useUpload("photos"), options);
    await act(() => sender.result.current.upload(note("alpha", "a.txt")));
    await act(() => other.result.current.upload(note("bravo", "b.txt")));

    expect({
      sender: statuses(sender.result.current.files),
      reader: statuses(reader.result.current.files),
      readerTotals: reader.result.current.totals.done,
      other: statuses(other.result.current.files),
      uploads: fixture.requests.filter((request) => request === "POST /upload").length,
    }).toEqual({ sender: ["a.txt done"], reader: ["a.txt done"], readerTotals: 1, other: ["b.txt done"], uploads: 2 });
  });

  it("clear() from one component clears the route's settled uploads for every component on it", async () => {
    const { useUpload } = setup();
    const sender = renderHook(() => useUpload("notes"));
    const reader = renderHook(() => useUpload("notes"));
    const other = renderHook(() => useUpload("photos"));
    await act(() => sender.result.current.upload(note("alpha", "a.txt")));
    await act(() => other.result.current.upload(note("bravo", "b.txt")));
    act(() => reader.result.current.clear());

    expect({
      sender: statuses(sender.result.current.files),
      reader: statuses(reader.result.current.files),
      other: statuses(other.result.current.files),
    }).toEqual({ sender: [], reader: [], other: ["b.txt done"] });
  });
});
