// @vitest-environment happy-dom
// Contract: spec §6.1 (M4-B2): getDropProps() makes any element a drop target. `isDragOver` is true from the first
// dragenter until the drag leaves the element or drops, including while it crosses the element's children; dragover and
// drop have their default prevented, without which a browser refuses the drop or opens the file; a drop uploads the
// files, only the first one unless the hook takes `multiple` (ruling M4-B9).
// Oracle: the events a browser fires when a drag moves from an element onto its child and out (HTML drag-and-drop
// processing model: dragenter on the new target, then dragleave on the old one), and the files the hook then lists.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { InferableCloudrop } from "../client.ts";
import { createUploadHooks, type UploadHooks } from "../react.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture } from "../testing/client-fixture.ts";

/** waitFor polls every 50 ms by default; these renders follow microtasks and 0 ms backoffs. */
const fast = { interval: 1 };
const note = (text: string, name: string) => new File([text], name, { type: "text/plain" });

type UseUpload = UploadHooks<InferableCloudrop>["useUpload"];

/** A drop zone with a child element; the zone's `data-over` mirrors isDragOver and the child lists the files. */
function Zone({ useUpload, multiple }: { useUpload: UseUpload; multiple: boolean }) {
  const { files, isDragOver, getDropProps } = useUpload("notes", { multiple });
  const listed = files.map((file) => `${file.name} ${file.status}`).join(", ");
  return createElement(
    "div",
    { ...getDropProps(), "data-testid": "zone", "data-over": String(isDragOver) },
    createElement("p", { "data-testid": "child" }, listed),
  );
}

function renderZone(multiple: boolean) {
  const fixture = clientFixture({ notes: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }) });
  const { useUpload } = createUploadHooks({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
  const view = render(createElement(Zone, { useUpload, multiple }));
  const zone = view.getByTestId("zone");
  const child = view.getByTestId("child");
  return { zone, child, over: () => zone.dataset.over, listed: () => child.textContent };
}

afterEach(cleanup);

describe("getDropProps", () => {
  it("stays over while the drag crosses a child, ends on leave and on drop, and uploads every dropped file", async () => {
    const { zone, child, over, listed } = renderZone(true);
    const seen: Record<string, unknown> = {};

    fireEvent.dragEnter(zone);
    seen.entered = over();
    fireEvent.dragEnter(child);
    fireEvent.dragLeave(zone);
    seen.onChild = over();
    fireEvent.dragLeave(child);
    seen.left = over();
    fireEvent.dragEnter(zone);
    // fireEvent returns false when a handler called preventDefault().
    seen.dragOverAllowed = fireEvent.dragOver(zone);
    seen.dropAllowed = fireEvent.drop(child, {
      dataTransfer: { files: [note("alpha", "a.txt"), note("bravo", "b.txt")] },
    });
    seen.dropped = over();
    await waitFor(() => expect(listed()).toBe("a.txt done, b.txt done"), fast);

    expect(seen).toEqual({
      entered: "true",
      onChild: "true",
      left: "false",
      dragOverAllowed: false,
      dropAllowed: false,
      dropped: "false",
    });
  });

  it("uploads only the first dropped file when the hook takes one file", async () => {
    const { zone, listed } = renderZone(false);
    fireEvent.dragEnter(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [note("alpha", "a.txt"), note("bravo", "b.txt")] } });

    await waitFor(() => expect(listed()).toBe("a.txt done"), fast);
  });
});
