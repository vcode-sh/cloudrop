import { describe, expect, it } from "vitest";
import { matchAccept, normalizeType } from "./accept.ts";

describe("normalizeType", () => {
  it("stores a file the browser could not type as application/octet-stream", () => {
    expect(normalizeType("")).toBe("application/octet-stream");
  });

  it("lowercases a type", () => {
    expect(normalizeType("Image/PNG")).toBe("image/png");
  });

  it.for([
    // Blob.type keeps parameters, but a parameter signed and stored as part of the type would dodge the
    // inline/attachment rule, so only the essence is kept (M9-H1).
    { type: "text/html; charset=utf-8", essence: "text/html" },
    { type: "text/csv;charset=UTF-8", essence: "text/csv" },
    { type: "Image/PNG ; x=1", essence: "image/png" },
  ])("keeps only the essence of $type", ({ type, essence }) => {
    expect(normalizeType(type)).toBe(essence);
  });

  it.for([
    { name: "parameters but no type", type: "; charset=utf-8" },
    { name: "no subtype", type: "image" },
    { name: "a line break", type: "image/png\r\nx-amz-meta-a: b" },
    { name: "a wildcard", type: "image/*" },
  ])("rejects a type with $name", ({ type }) => {
    expect(normalizeType(type)).toBeNull();
  });
});

describe("matchAccept", () => {
  it("keeps an extension that agrees with the type, in lower case", () => {
    expect(matchAccept(["image/*"], "image/jpeg", "Holiday.JPEG")).toEqual({ ext: ".jpeg" });
  });

  it("gives a known type its usual extension when the name has none", () => {
    expect(matchAccept(["image/png"], "image/png", "clipboard")).toEqual({ ext: ".png" });
  });

  it("refuses an extension that contradicts a known type", () => {
    expect(matchAccept(["image/*"], "image/png", "payload.html")).toEqual({
      problem: "The file name ends in .html, which does not match its type image/png. Rename the file or pick another.",
    });
  });

  it.for([
    { name: "a line break", file: "a.png\r\nx-amz-meta-a: b" },
    { name: "markup", file: "a.<img src=x onerror=1>" },
    { name: "a slash", file: "dir.x/file" },
  ])("does not echo an extension with $name back to the client", ({ file }) => {
    expect(matchAccept(["image/*"], "image/png", file)).toEqual({
      problem: "The file name's extension does not match its type image/png. Rename the file or pick another.",
    });
  });

  it("treats a trailing dot as a name without an extension", () => {
    expect(matchAccept(["image/png"], "image/png", "photo.")).toEqual({ ext: ".png" });
  });

  it("refuses a contradictory extension hidden by trailing dots", () => {
    expect(matchAccept(["image/png"], "image/png", "payload.html..")).toEqual({
      problem: "The file name ends in .html, which does not match its type image/png. Rename the file or pick another.",
    });
  });

  it("refuses a type outside the list, naming it", () => {
    expect(matchAccept(["image/png", "image/jpeg"], "image/gif", "a.gif")).toEqual({
      problem: "This upload does not accept image/gif files.",
    });
  });

  it("does not let image/* match a type that only starts with the same letters", () => {
    // A prefix check on "image" instead of "image/" would accept "imagex/evil".
    expect(matchAccept(["image/*"], "imagex/evil", "a.evil")).toEqual({
      problem: "This upload does not accept imagex/evil files.",
    });
  });

  it("matches a type outside the extension table by MIME alone and keeps a plain extension", () => {
    expect(matchAccept(["*/*"], "application/octet-stream", "backup.tar.gz")).toEqual({ ext: ".gz" });
  });

  it("drops an unusual extension of an unknown type instead of putting it in the key", () => {
    expect(matchAccept(["*/*"], "application/octet-stream", "notes.ünïcode")).toEqual({ ext: "" });
  });

  it("keeps the extension of a known type out of the key of a file declared as something else", () => {
    expect(matchAccept(["*/*"], "application/octet-stream", "payload.html")).toEqual({ ext: "" });
  });

  it("treats a leading dot as part of the name, not an extension", () => {
    expect(matchAccept(["text/plain"], "text/plain", ".env")).toEqual({ ext: ".txt" });
  });
});
