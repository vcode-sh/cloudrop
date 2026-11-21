// A file's name in the key (M11-R222): a route whose `key` or `prefix` function builds the key from `file.name` gets
// names a person's files really have. A name the key cannot hold refuses that file alone; a key that is bad for
// another reason is still the route's bug.

import { describe, expect, it } from "vitest";
import type { FileTicket } from "../protocol/types.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { storeFixture } from "../testing/store-fixture.ts";
import { upload } from "../testing/upload-fixture.ts";
import { route } from "./route.ts";

const user = { accept: "*/*", maxSize: "1GB", maxFiles: 20, authorize: () => ({ userId: "u1" }) } as const;
/** The key most apps write first: the user's folder and the file's own name. */
const named = route(user, { key: ({ userId, file }) => `users/${userId}/${file.name}` });
const plain = route(user);

/** A file the browser could not type, as it sends "Icon\r": no extension rule applies to its name. */
const file = (name: string) => ({ name, size: 1, type: "" });
/** What each file of the request was answered: its key, or the error of its own ticket. */
const answers = (tickets: FileTicket[]) =>
  tickets.map((ticket) => (ticket.kind === "rejected" ? ticket.error : ticket.key));
const refusal = (problem: string) => ({
  code: "INVALID_INPUT",
  message: `This file's name ${problem}, which this upload cannot store. Rename the file, then add it again.`,
  retryable: false,
});
const control = (codePoint: string) => refusal(`has a control character (${codePoint})`);
const PARTS = refusal('has a "." or ".." part, or an empty part beside a "/"');

// The name is judged before the store is asked (upload.ts), so a server without one shows it; the store's own part,
// which rows it reserves and what it answers beside them, is the last test of this file.
describe("POST /upload on a route that puts file.name in the key", () => {
  it.for([
    // macOS names a folder's icon file "Icon\r"; Linux and macOS allow every one of these in a name.
    { name: "a trailing CR", sent: "Icon\r", answer: control("U+000D") },
    { name: "DEL", sent: "a\u007fb.txt", answer: control("U+007F") },
    { name: "the C1 control U+0085", sent: "a\u0085b.txt", answer: control("U+0085") },
    // Neither is a control character: a key holds them.
    { name: "a no-break space", sent: "a b.txt", answer: "users/u1/a b.txt" },
    { name: "a line separator (U+2028)", sent: "a b.txt", answer: "users/u1/a b.txt" },
    { name: "a leading space", sent: " a.txt", answer: "users/u1/ a.txt" },
    { name: "a trailing space", sent: "a.txt ", answer: "users/u1/a.txt " },
    { name: "a leading dot", sent: ".profile", answer: "users/u1/.profile" },
    { name: "a trailing dot", sent: "a.", answer: "users/u1/a." },
    { name: "a backslash", sent: "a\\b.txt", answer: "users/u1/a\\b.txt" },
    // No file system gives a file these names; a request written by hand can.
    { name: "the name ..", sent: "..", answer: PARTS },
    { name: "the name .", sent: ".", answer: PARTS },
    { name: "the name /", sent: "/", answer: PARTS },
    { name: "a trailing slash", sent: "a/", answer: PARTS },
    { name: "a slash inside", sent: "a/b.txt", answer: "users/u1/a/b.txt" },
  ])("answers a name with $name in its own ticket, and the file beside it goes on", async ({ sent, answer }) => {
    const fixture = serverFixture({ named });
    const { status, body } = await upload(fixture, { route: "named", files: [file("first.txt"), file(sent)] });
    expect({ status, answers: answers(body.files) }).toEqual({ status: 200, answers: ["users/u1/first.txt", answer] });
    expect(fixture.logger.errors).toEqual([]);
  });

  it("refuses a name whose control character reaches the key in another case or through prefix", async () => {
    const lowered = route(user, { key: ({ file: { name } }) => `u/${name.toLowerCase()}` });
    const foldered = route(user, { prefix: ({ file: { name } }) => `by-name/${name}` });
    const fixture = serverFixture({ lowered, foldered });
    const files = [file("first.txt"), file("Icon\r")];
    const [inKey, inPrefix] = [
      await upload(fixture, { route: "lowered", files }),
      await upload(fixture, { route: "foldered", files }),
    ];
    expect(answers(inKey.body.files)).toEqual(["u/first.txt", control("U+000D")]);
    expect(answers(inPrefix.body.files)[1]).toEqual(control("U+000D"));
  });

  // The name is not what made these keys unusable: they stay the route's bug, a 500 with the reason in the log.
  it.for([
    {
      name: "a control character the name does not have",
      key: (name: string) => `u\u0001/${name}`,
      log: "The object key contains control characters. Remove them.",
    },
    {
      name: "a .. segment of the route's own",
      key: (name: string) => `u/../${name}`,
      log: "The object key contains a '.' or '..' segment. Use plain path segments.",
    },
    { name: "nothing", key: () => "", log: "The object key is empty. Pass a non-empty key." },
  ])("answers a key with $name with a 500, for a name with a CR too", async ({ key, log }) => {
    const broken = route(user, { key: ({ file: { name } }) => key(name) });
    const fixture = serverFixture({ broken });
    const { status, body } = await upload(fixture, { route: "broken", files: [file("Icon\r")] });
    expect({ status, code: body.error?.code, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: `TypeError: Route "broken" built an unusable key: ${log}`,
    });
  });

  it("gives every such name a key of its own making on a route without a key function", async () => {
    const fixture = serverFixture({ plain });
    const sent = ["Icon\r", "a\nb.txt", "a\u0085b.txt", " a.txt ", ".profile", "a.", "..", ".", "/", "a/b.txt", "a\\b"];
    const { body } = await upload(fixture, { route: "plain", files: sent.map(file) });
    // A ULID and, at most, the name's extension in lower-case letters and digits.
    const odd = answers(body.files).filter((key) => !/^[0-9A-HJKMNP-TV-Z]{26}(?:\.[a-z0-9]{1,16})?$/.test(String(key)));
    expect(odd).toEqual([]);
  });

  // The header is stored as it was signed: a browser that downloads the file reads the name from filename*.
  it.for([
    { name: "a no-break space", sent: "a b.txt", header: `filename="a_b.txt"; filename*=UTF-8''a%C2%A0b.txt` },
    { name: "a line separator", sent: "a b.txt", header: `filename="a_b.txt"; filename*=UTF-8''a%E2%80%A8b.txt` },
    { name: "spaces around it", sent: " a.txt ", header: `filename=" a.txt "; filename*=UTF-8''%20a.txt%20` },
    { name: "a leading dot", sent: ".profile", header: `filename=".profile"; filename*=UTF-8''.profile` },
    { name: "the name ..", sent: "..", header: `filename=".."; filename*=UTF-8''..` },
    { name: "a slash", sent: "a/b.txt", header: `filename="a/b.txt"; filename*=UTF-8''a%2Fb.txt` },
    { name: "a backslash", sent: "a\\b.txt", header: `filename="a_b.txt"; filename*=UTF-8''a%5Cb.txt` },
  ])("stores a name with $name in the object's Content-Disposition", async ({ sent, header }) => {
    const fixture = serverFixture({ plain });
    const ticket = await fixture.single("plain", file(sent));
    const put = await fixture.send(ticket.put, new Uint8Array([1]));
    expect(put.status).toBe(200);
    expect(fixture.fake.object(ticket.key)?.headers.disposition).toBe(`attachment; ${header}`);
  });
});

it("with a store, answers such a name in its own ticket and reserves no row for it", async () => {
  const owned = route(user, { owner: ({ userId }) => userId, key: ({ file: { name } }) => `mine/${name}` });
  const fixture = storeFixture({ named: owned });
  const { body } = await upload(fixture, { route: "named", files: [file("first.txt"), file("Icon\r"), file("..")] });
  expect(answers(body.files)).toEqual(["mine/first.txt", control("U+000D"), PARTS]);
  expect((await fixture.store.raw.files()).map((row) => row.name)).toEqual(["first.txt"]);
});
