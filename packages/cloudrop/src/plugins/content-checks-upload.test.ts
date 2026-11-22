import { describe, expect, it } from "vitest";
import type { RefusedKind } from "../errors.ts";
import type { FileDescriptor } from "../protocol/types.ts";
import { allowAnyone, route } from "../server/route.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { type ContentCheckOptions, contentChecks } from "./content-checks.ts";

/** Asks /upload for tickets for `files` on a route that accepts `accept`; reports the answer and the tickets' kinds. */
async function ask(accept: string | string[], files: Omit<FileDescriptor, "size">[], options?: ContentCheckOptions) {
  const uploads = route({ accept, maxSize: "1MB", authorize: allowAnyone });
  const fixture = serverFixture({ uploads }, { plugins: [contentChecks(options)] });
  const response = await fixture.post("upload", {
    route: "uploads",
    files: files.map((file) => ({ ...file, size: 10 })),
  });
  const body = await response.json();
  return {
    status: response.status,
    error: body.error ?? null,
    tickets: body.files?.map(({ kind }: { kind: string }) => kind) ?? [],
  };
}

const refused = (type: string, kind: RefusedKind) => ({
  status: 400,
  error: {
    code: "FILE_TYPE_NOT_ALLOWED",
    message: `One of the files was sent as ${type}, which this upload does not accept. Pick another file.`,
    retryable: false,
    // No bytes exist yet, so the declared type is all a refusal names (M11-K2), with its kind (M12-E6).
    content: { declared: type, reason: "refused", kind },
  },
  tickets: [],
});
const signed = { status: 200, error: null, tickets: ["single"] };

describe("contentChecks at /upload: the declared type, before anything is signed", () => {
  it.for([
    {
      name: "a web page on a route that accepts anything",
      accept: "*/*",
      type: "text/html",
      expected: refused("text/html", "web-page"),
    },
    {
      name: "an SVG on a route that accepts every image",
      accept: "image/*",
      type: "image/svg+xml",
      expected: refused("image/svg+xml", "svg"),
    },
    { name: "an SVG on a route that names its type", accept: "image/svg+xml", type: "image/svg+xml", expected: signed },
    { name: "an XSLT style sheet", accept: "*/*", type: "text/xsl", expected: refused("text/xsl", "xml") },
    {
      name: "an old JavaScript type",
      accept: "*/*",
      type: "text/x-javascript",
      expected: refused("text/x-javascript", "script"),
    },
    // A browser sniffs a file of this type, and may render it as a web page (WHATWG MIME Sniffing §7).
    {
      name: "the unknown type",
      accept: "*/*",
      type: "unknown/unknown",
      expected: refused("unknown/unknown", "web-page"),
    },
    {
      name: "a Windows installer",
      accept: "*/*",
      type: "application/x-msi",
      expected: refused("application/x-msi", "installer"),
    },
    {
      name: "a program by shared-mime-info's type for .exe",
      accept: "*/*",
      type: "application/x-ms-dos-executable",
      expected: refused("application/x-ms-dos-executable", "program"),
    },
    // Firefox renders each part of it by the part's own type, an HTML part as a web page.
    {
      name: "a multipart replacing stream",
      accept: "*/*",
      type: "multipart/x-mixed-replace",
      expected: refused("multipart/x-mixed-replace", "web-page"),
    },
    { name: "a PDF", accept: "*/*", type: "application/pdf", expected: signed },
  ])("$name", async ({ accept, type, expected }) => {
    expect(await ask(accept, [{ name: "file", type }])).toEqual(expected);
  });

  it("refuses the whole request when one of its files is refused", async () => {
    const files = [
      { name: "a.png", type: "image/png" },
      { name: "a.html", type: "text/html" },
    ];
    expect(await ask("*/*", files)).toEqual(refused("text/html", "web-page"));
  });

  it.for([
    { name: "allow signs a web page", options: { allow: ["text/html"] }, expected: signed },
    {
      name: "deny wins over allow",
      options: { allow: ["text/html"], deny: ["text/*"] },
      expected: refused("text/html", "web-page"),
    },
  ])("$name on a route that accepts it", async ({ options, expected }) => {
    expect(await ask("text/html", [{ name: "a.html", type: "text/html" }], options)).toEqual(expected);
  });

  it("deny refuses a type by its declared type alone", async () => {
    const options = { deny: ["application/zip"] };
    expect(await ask("*/*", [{ name: "a.zip", type: "application/zip" }], options)).toEqual(
      refused("application/zip", "denied"),
    );
  });
});
