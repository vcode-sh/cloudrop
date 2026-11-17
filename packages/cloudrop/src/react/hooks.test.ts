// Contract: spec §6.1 and §6.2 (M4-B1, M4-B3, M4-B4): server rendering, where React Server Components and SSR load a
// "use client" module too, reads a constant empty state and never creates the client.
// Oracle: createCloudropClient throws on a basePath with no leading slash (readOptions in client.ts), so a render that
// finishes created no client. This file runs on Node, as a server render does: there is no window or document.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InferableCloudrop } from "../client.ts";
import { createUploadHooks, type UploadHooks } from "../react.ts";

function Page({ hooks }: { hooks: UploadHooks<InferableCloudrop> }) {
  const { files, totals, isUploading, isDragOver } = hooks.useUpload("notes");
  const { uploads } = hooks.useResumable();
  const shown = [files.length, totals.count, totals.progress, isUploading, isDragOver, uploads.length];
  return createElement("p", null, shown.join(" "));
}

describe("createUploadHooks on the server", () => {
  it("renders no files, zero totals and no resumable uploads, without creating a client", () => {
    const hooks = createUploadHooks({ basePath: "api/cloudrop" });

    expect(renderToString(createElement(Page, { hooks }))).toBe("<p>0 0 0 false false 0</p>");
  });
});
