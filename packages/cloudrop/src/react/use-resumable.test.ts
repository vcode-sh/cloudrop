// @vitest-environment happy-dom
// Contract: spec §6.1 and §6.2 (M4-B2, M4-B3, M4-B12): useResumable lists the client's resumable(), which leaves out
// the uploads this page holds (M4-F22), read after mount, when a job of the hooks starts, whenever one of its files
// ends or starts again, and when it settles; `[]` before the first read. useUpload's resume(upload, file) continues a
// record into that hook's `files`; refresh() reads again and resolves with the client's Result.
// Oracle: the page before the reload (persist-fixture's reloaded(): a four-part upload interrupted after two parts)
// leaves exactly one record; a failed multipart file of start() keeps its record for retry(), and a file that ends done
// deletes it (resume spec §2, client/persist.ts); the fake IndexedDB holds what the browser keeps.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadHooks } from "../react.ts";
import {
  firstOf,
  fourParts,
  gate,
  nth,
  partThree,
  persistFixture,
  reloaded,
  threeParts,
} from "../testing/persist-fixture.ts";
import { failing, fast } from "../testing/react-fixture.ts";

const ids = (uploads: readonly { id: string }[] | null | undefined) => uploads?.map(({ id }) => id);
/** The ids of the records the fake IndexedDB holds. */
const stored = (setup: { db: { stored(): Record<string, unknown> } }) => Object.keys(setup.db.stored());

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useResumable", () => {
  // About 100 ms: the four-part file is 24 MiB, sent and checksummed in process.
  it("lists the upload left before the reload, resumes it into files, and lists nothing once it is done", async () => {
    const setup = await reloaded(gate(partThree));
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    const beforeRead = result.current.resumable.uploads;
    await waitFor(() => expect(result.current.resumable.uploads.map(({ id }) => id)).toEqual([setup.upload.id]), fast);
    const [record] = result.current.resumable.uploads;
    if (!record) throw new Error("useResumable listed no upload.");

    const answer = await act(() => result.current.hook.resume(record, fourParts()));
    await setup.drained();
    await waitFor(() => expect(result.current.resumable.uploads).toEqual([]), fast);

    expect({
      beforeRead,
      error: answer.error,
      files: result.current.hook.files.map((file) => `${file.name} ${file.status}`),
    }).toEqual({ beforeRead: [], error: null, files: ["b.bin done"] });
  });

  it("refresh() reads the list again and resolves with the client's answer", async () => {
    const setup = await reloaded(gate(partThree));
    const { useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => useResumable());
    await waitFor(() => expect(result.current.uploads).toHaveLength(1), fast);
    await setup.client.forget();

    const answer = await act(() => result.current.refresh());

    expect({ answer, uploads: result.current.uploads }).toEqual({ answer: { data: [], error: null }, uploads: [] });
  });

  it("hides a listed upload while its own resume runs", async () => {
    const resumedPart = gate(nth("PUT part 3", 2));
    const setup = await reloaded(gate(partThree), resumedPart.fault);
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    const [record] = result.current.resumable.uploads;
    if (!record) throw new Error("useResumable listed no upload.");

    let resumed: Promise<unknown> = Promise.resolve();
    act(() => {
      resumed = result.current.hook.resume(record, fourParts());
    });
    await act(() => resumedPart.reached);
    await waitFor(() => expect(result.current.resumable.uploads).toEqual([]), fast);
    const whileRunning = {
      status: result.current.hook.files[0]?.status,
      kept: stored(setup),
    };
    resumedPart.open();
    await act(() => resumed);
    await setup.drained();

    expect({ whileRunning, after: result.current.resumable.uploads }).toEqual({
      whileRunning: { status: "uploading", kept: [setup.upload.id] },
      after: [],
    });
  });

  it("never lists this page's failed file, and lists nothing once its retry() ends done", async () => {
    const broken = failing((call) => call.label === "PUT part 2");
    const setup = persistFixture({ fault: broken.fault, options: { concurrency: 1 } });
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await act(() => result.current.hook.upload(threeParts()));
    await setup.drained();
    const whileFailed = {
      status: result.current.hook.files[0]?.status,
      listed: ids((await act(() => result.current.resumable.refresh())).data),
      kept: stored(setup).length,
    };
    broken.failing.on = false;
    await act(() => result.current.hook.files[0]?.retry());
    await setup.drained();

    expect({
      whileFailed,
      after: result.current.resumable.uploads,
      kept: stored(setup),
    }).toEqual({
      whileFailed: { status: "failed", listed: [], kept: 1 },
      after: [],
      kept: [],
    });
  });

  it("lists nothing once a retried file is cancelled while its /complete is in doubt", async () => {
    const broken = failing((call) => call.label === "PUT part 2");
    // The retry's /complete is held, then gets no answer: it may have finished, so the cancel sends no /abort and the
    // client deletes the record and releases the upload right after the file settles aborted (M3-H16, end() in
    // client/file-run.ts).
    const complete = Promise.withResolvers<void>();
    const lose = Promise.withResolvers<never>();
    const held = (call: { label: string }) => {
      if (call.label !== "POST /complete") return undefined;
      complete.resolve();
      return lose.promise;
    };
    const setup = persistFixture({ fault: firstOf(broken.fault, held), options: { concurrency: 1 } });
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await act(() => result.current.hook.upload(threeParts()));
    await setup.drained();
    broken.failing.on = false;
    let retried: Promise<unknown> = Promise.resolve();
    act(() => {
      retried = result.current.hook.retry();
    });
    await act(() => complete.promise);
    act(() => result.current.hook.abort());
    lose.reject(new TypeError("Failed to fetch"));
    await act(() => retried);
    await setup.drained();

    expect({
      status: result.current.hook.files[0]?.status,
      stored: stored(setup),
      listed: result.current.resumable.uploads,
    }).toEqual({ status: "aborted", stored: [], listed: [] });
  });

  it("lists an upload again once its resume is cancelled while its checks run", async () => {
    const setup = await reloaded(gate(partThree));
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    const [record] = result.current.resumable.uploads;
    if (!record) throw new Error("useResumable listed no upload.");

    const resumed = act(() => {
      const answer = result.current.hook.resume(record, fourParts());
      // Ends the file at once (M4-F2); the checks still run, and let the upload go when they end.
      result.current.hook.abort();
      return answer;
    });
    const answer = await resumed;
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);

    expect({ code: answer.error?.code, status: result.current.hook.files[0]?.status }).toEqual({
      code: "ABORTED",
      status: "aborted",
    });
  });

  it("lists an upload while another tab holds it, and nothing once the refused resume's retry() ends done", async () => {
    const setup = await reloaded(gate(partThree));
    const otherTabLetsGo = setup.locks.holdElsewhere(`cloudrop:upload:${setup.upload.id}`);
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    const [record] = result.current.resumable.uploads;
    if (!record) throw new Error("useResumable listed no upload.");

    const refused = (await act(() => result.current.hook.resume(record, fourParts()))).error?.code;
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    otherTabLetsGo();
    const retried = await act(() => result.current.hook.files[0]?.retry());
    await setup.drained();
    await waitFor(() => expect(result.current.resumable.uploads).toEqual([]), fast);

    expect({ refused, retried: retried?.status, stored: stored(setup) }).toEqual({
      refused: "UPLOAD_IN_USE",
      retried: "done",
      stored: [],
    });
  });

  it("keeps listing an earlier upload while the same file is uploaded anew", async () => {
    // The new upload's part 2 fails: the page before the reload sent part 2 once already.
    const broken = failing((call) => call.label === "PUT part 2" && call.nth >= 2);
    const setup = await reloaded(gate(partThree), broken.fault);
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    // Uploaded anew, not resumed: a new upload under its own id, which resumable() tells from the earlier one's.
    await act(() => result.current.hook.upload(fourParts()));
    await setup.drained();

    expect({
      status: result.current.hook.files[0]?.status,
      listed: ids(result.current.resumable.uploads),
      stored: stored(setup).length,
    }).toEqual({ status: "failed", listed: [setup.upload.id], stored: 2 });
  });
});
