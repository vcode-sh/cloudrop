import { describe, expect, it } from "vitest";
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

const refused = (type: string) => ({
  status: 400,
  error: {
    code: "FILE_TYPE_NOT_ALLOWED",
    message: `One of the files was sent as ${type}, which this upload does not accept. Pick another file.`,
    retryable: false,
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
      expected: refused("text/html"),
    },
    {
      name: "an SVG on a route that accepts every image",
      accept: "image/*",
      type: "image/svg+xml",
      expected: refused("image/svg+xml"),
    },
    { name: "an SVG on a route that names its type", accept: "image/svg+xml", type: "image/svg+xml", expected: signed },
    { name: "an XSLT style sheet", accept: "*/*", type: "text/xsl", expected: refused("text/xsl") },
    {
      name: "an old JavaScript type",
      accept: "*/*",
      type: "text/x-javascript",
      expected: refused("text/x-javascript"),
    },
    // A browser sniffs a file of this type, and may render it as a web page (WHATWG MIME Sniffing §7).
    { name: "the unknown type", accept: "*/*", type: "unknown/unknown", expected: refused("unknown/unknown") },
    { name: "a PDF", accept: "*/*", type: "application/pdf", expected: signed },
  ])("$name", async ({ accept, type, expected }) => {
    expect(await ask(accept, [{ name: "file", type }])).toEqual(expected);
  });

  it("refuses the whole request when one of its files is refused", async () => {
    const files = [
      { name: "a.png", type: "image/png" },
      { name: "a.html", type: "text/html" },
    ];
    expect(await ask("*/*", files)).toEqual(refused("text/html"));
  });

  it.for([
    { name: "allow signs a web page", options: { allow: ["text/html"] }, expected: signed },
    {
      name: "deny wins over allow",
      options: { allow: ["text/html"], deny: ["text/*"] },
      expected: refused("text/html"),
    },
  ])("$name on a route that accepts it", async ({ options, expected }) => {
    expect(await ask("text/html", [{ name: "a.html", type: "text/html" }], options)).toEqual(expected);
  });

  it("deny refuses a type by its declared type alone", async () => {
    const options = { deny: ["application/zip"] };
    expect(await ask("*/*", [{ name: "a.zip", type: "application/zip" }], options)).toEqual(refused("application/zip"));
  });
});
