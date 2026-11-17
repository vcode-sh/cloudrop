// @vitest-environment happy-dom
// Contract: spec §6.1 and §6.2 (M4-B2, M4-B3): useResumable lists the client's resumable() after mount and again after
// every job the hooks started settles, `[]` before the first read; useUpload's resume(upload, file) continues a record
// into that hook's `files`; refresh() reads again and resolves with the client's Result.
// Oracle: the page before the reload (persist-fixture's reloaded(): a four-part upload interrupted after two parts)
// leaves exactly one record, and a resumed upload that ends done deletes it (resume spec §2).

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadHooks } from "../react.ts";
import { fourParts, gate, partThree, reloaded } from "../testing/persist-fixture.ts";

/** waitFor polls every 50 ms by default; these renders follow microtasks and 0 ms backoffs. */
const fast = { interval: 1 };

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
});
