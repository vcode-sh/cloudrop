// Every text an /upload request carries, with the characters that break things downstream (M11-R196): a file's name and
// type, the metadata and the idempotency key. Each either reaches the store and the signed Content-Disposition as it
// came, or is refused before either sees it, for its own file alone where the text is a file's.

import { describe, expect, it } from "vitest";
import type { FileTicket } from "../protocol/types.ts";
import { owned, storeFixture } from "../testing/store-fixture.ts";
import { upload } from "../testing/upload-fixture.ts";
import { route } from "./route.ts";
import type { StandardSchema } from "./schema.ts";

const file = (name: string, type = "text/plain") => ({ name, size: 1, type });
const outcomes = (tickets: FileTicket[]) =>
  tickets.map((ticket) => (ticket.kind === "rejected" ? ticket.error.message : ticket.kind));

describe("POST /upload: the texts of a request", () => {
  it.for([
    { name: "NUL", sent: "a\u0000b.txt", problem: "has a NUL character (U+0000), which cannot be stored" },
    { name: "a lone high surrogate", sent: "a\ud800.txt", problem: "is not valid Unicode (it has a lone surrogate)" },
    { name: "a lone low surrogate", sent: "\udc00a.txt", problem: "is not valid Unicode (it has a lone surrogate)" },
  ])("refuses a name with $name for that file alone, before the store sees it", async ({ sent, problem }) => {
    const fixture = storeFixture({ owned });
    const { status, body } = await upload(fixture, { route: "owned", files: [file("first.txt"), file(sent)] });
    expect(status).toBe(200);
    expect(body.files.map((ticket) => (ticket.kind === "rejected" ? ticket.error : ticket.kind))).toEqual([
      "single",
      {
        code: "INVALID_INPUT",
        message: `This file's name ${problem}. Rename the file, then add it again.`,
        retryable: false,
      },
    ]);
    expect((await fixture.store.raw.files()).map((row) => row.name)).toEqual(["first.txt"]);
  });

  // The header is signed and sent as it is: a raw CR, LF or quote in it would end the value or start another header.
  it.for([
    {
      name: "CR, LF and a quote",
      sent: 'a\r\nX-Injected: 1".txt',
      header: `attachment; filename="a__X-Injected: 1_.txt"; filename*=UTF-8''a%0D%0AX-Injected%3A%201%22.txt`,
    },
    {
      name: "a trailing CR, as macOS names a folder's icon file",
      sent: "Icon\r",
      header: `attachment; filename="Icon_"; filename*=UTF-8''Icon%0D`,
    },
    {
      name: "a tab, ESC and a backslash",
      sent: "a\tb\u001b[31m\\.txt",
      header: `attachment; filename="a_b_[31m_.txt"; filename*=UTF-8''a%09b%1B%5B31m%5C.txt`,
    },
    {
      name: "DEL and a C1 control",
      sent: "a\u007fb\u0085.txt",
      header: `attachment; filename="a_b_.txt"; filename*=UTF-8''a%7Fb%C2%85.txt`,
    },
  ])("keeps a name with $name, percent-encoded in Content-Disposition", async ({ sent, header }) => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", file(sent));
    expect(ticket.put.headers["content-disposition"]).toBe(header);
    expect((await fixture.store.raw.files()).map((row) => row.name)).toEqual([sent]);
  });

  it.for([
    { name: "NUL", type: "text/\u0000plain" },
    { name: "a lone surrogate", type: "text/plain\ud800" },
  ])("refuses a type with $name for that file alone", async ({ type }) => {
    const fixture = storeFixture({ owned });
    const { body } = await upload(fixture, { route: "owned", files: [file("a.txt", type), file("b.txt")] });
    expect(outcomes(body.files)).toEqual(["The file's type is not a valid MIME type. Pick another file.", "single"]);
    expect((await fixture.store.raw.files()).map((row) => row.name)).toEqual(["b.txt"]);
  });

  it("stores metadata keys and values with NUL, control characters and a lone surrogate as JSON escapes", async () => {
    const anything: StandardSchema<unknown> = {
      "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
    };
    const noted = route(
      { accept: "*/*", maxSize: "1GB", metadata: anything, authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId },
    );
    const fixture = storeFixture({ noted });
    const metadata = { "key\u0000": "value\u0000\ud800\r\n\u007f" };
    const { body } = await upload(fixture, { route: "noted", files: [file("a.txt")], metadata });
    expect(outcomes(body.files)).toEqual(["single"]);
    // JSON.stringify writes U+0000 to U+001F and a lone surrogate as escapes: plain ASCII a text column holds. DEL stays.
    expect((await fixture.store.raw.files()).map((row) => row.metadata)).toEqual([
      '{"key\\u0000":"value\\u0000\\ud800\\r\\n\u007f"}',
    ]);
  });

  it.for([
    { name: "NUL", idempotencyKey: "0123456789abcdef\u0000" },
    { name: "a lone surrogate", idempotencyKey: "0123456789abcdef\ud800" },
  ])("refuses an idempotencyKey with $name, and the request with it", async ({ idempotencyKey }) => {
    const fixture = storeFixture({ owned });
    const { body } = await upload(fixture, { route: "owned", files: [file("a.txt")], idempotencyKey });
    expect(body.error).toEqual({
      code: "INVALID_INPUT",
      message: 'Send idempotencyKey as 16 to 128 letters, digits, "-" or "_", such as a UUID, or leave it out.',
      retryable: false,
    });
    expect(await fixture.store.raw.files()).toEqual([]);
  });
});
