# Plugins

`cloudrop/plugins` holds the plugins cloudrop ships for `createCloudrop({ plugins })`. They run on the server only and
add nothing to the client. Today there is one, `contentChecks()`. To write your own, see
[Plugin hooks](server.md#plugin-hooks).

## contentChecks()

The browser declares a file's type, and `accept` checks that declaration, not the file. Without a check of the bytes,
a page can upload a web page or a program as `image/png`, and the bucket stores it with that type. `contentChecks()`
checks the declared type at `/upload`, before anything is signed, and the content at `/complete`, from the first 4 KiB
of the stored file.

```ts
import { createCloudrop, r2, route } from "cloudrop";
import { contentChecks } from "cloudrop/plugins";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "uploads" }),
  routes: {
    avatar: route({ accept: "image/*", maxSize: "5MB", authorize }),
    document: route({ accept: ["application/pdf", "image/*"], maxSize: "50MB", authorize }),
  },
  plugins: [contentChecks()],
});
```

### What it refuses

At `/upload`, before anything is signed, a request with a file **sent as** one of these types:

1. **A web page, a program or a script.** `text/html`, `application/xhtml+xml`, the program types (such as
   `application/x-msdownload`), every JavaScript type WHATWG lists (`text/javascript`, `text/x-javascript`,
   `text/jscript` and the rest) and the shell script types. Also `unknown/unknown` and `application/unknown`, which a
   browser sniffs and may render as a page. `allow` lets a type through.
2. **An XML type the route does not name.** A browser renders XML, and runs the scripts an SVG or an XHTML element in
   it carries. `text/xml`, `application/xml`, `text/xsl` and every `+xml` type, `image/svg+xml` among them, pass only
   when the route's `accept` lists that exact type, such as `accept: ["image/png", "image/svg+xml"]`; `image/*` and
   `*/*` are not enough. `allow` lets a type through.

A refusal at `/upload` refuses the whole request, as any `beforeUpload` refusal does.

At `/complete`, a file whose **first bytes show**:

3. **A web page, a program, a script, or XML the route does not name**, whatever the file was sent as.
4. **A type that contradicts the declared type.** A JPEG sent as `image/png`, a PDF sent as `text/plain`, a ZIP sent as
   an image. A content type agrees with its common aliases: `audio/x-wav` with a WAV, `image/heif` with a HEIC, a
   Word template or a macro-enabled document with a Word file. A ZIP whose entries do not say what it is agrees with
   any `application/` or `model/` type, since many formats are ZIP archives (APK, JAR, Visio, 3MF).
5. **For a file the browser could not type, a type the route does not accept.** Such a file is sent as
   `application/octet-stream`, which is not a contradiction; the content's own type must then be in `accept`.

A file whose first bytes match none of the formats below passes as the type it was sent as, which the route accepted
and rule 1 and 2 let through. Plain text, CSV, JSON and most text formats have no signature, so they pass this way.
JavaScript has none either: a script is refused by its declared type, or by a `#!` line.

### What happens to a refused file

The refusal is an `afterVerify` refusal, handled like any other (see [Plugin hooks](server.md#plugin-hooks)):

- The client gets `FILE_TYPE_NOT_ALLOWED` (400, not retryable) with a message for the person, such as "This file is a
  JPEG image, but it was sent as image/png. Give it the right extension, or pick another file." or "This file is a
  web page (HTML), which this upload does not accept. Pick another file."
- The object is deleted, only when it is this upload's.
- Every plugin's `onAbort` runs with `reason: "rejected"`.
- With a [database store](store.md), the file's row ends `rejected` before the object is deleted, and the owner's
  reserved bytes are released. A retried `/complete` answers `UPLOAD_EXPIRED`; nothing is ever `completed`.

When the bucket cannot be read, the object is kept and the client gets a retryable `SERVER_ERROR`; it completes again
on its own.

The content is judged only when `/complete` runs. A page that uploads a file and never completes it leaves the object
in the bucket under the type it was sent as, which `/upload` already checked, until the bucket's lifecycle rule or, with
a store, the sweep removes it. A browser shows such an object as that type.

### Options

| Option | What it does | Default |
| --- | --- | --- |
| `allow` | Types let through rules 1 to 3, such as `["text/html"]` on a route that takes web pages on purpose. The route's `accept` and rules 4 and 5 still apply. | `[]` |
| `deny` | Types refused on every route, by declared type at `/upload` and by what the first bytes show at `/complete`, such as `["application/zip"]` or `["video/*"]`. Wins over `allow`. | `[]` |

Both take exact types or a top-level wildcard such as `"image/*"`, in lower case. Anything else throws
`INVALID_CONFIG` when `contentChecks()` is called.

```ts
// A site builder that takes HTML pages, but never ZIP archives.
contentChecks({ allow: ["text/html"], deny: ["application/zip"] });
```

The plugin applies to every route. A type that one route takes and another must not belongs in each route's `accept`.

### What it recognises

| Content | Type | Recognised by | Defined in |
| --- | --- | --- | --- |
| PNG | `image/png` | `89 50 4E 47 0D 0A 1A 0A` | PNG Specification §5.2; WHATWG MIME Sniffing §6.1 |
| JPEG | `image/jpeg` | `FF D8 FF` | ITU-T T.81 Annex B; WHATWG §6.1 |
| GIF | `image/gif` | `GIF87a`, `GIF89a` | GIF89a specification §17; WHATWG §6.1 |
| WebP | `image/webp` | `RIFF`, 4 bytes, `WEBPVP` | RFC 9649 §2.5; WHATWG §6.1 |
| AVIF, HEIC, HEIF | `image/avif`, `image/heic`, `image/heif` | ISO BMFF `ftyp` box, major brand `avif`, `heic` and kin, `mif1` | AVIF §9.1; ISO/IEC 23008-12 |
| MP4, M4A, MOV, 3GP | `video/mp4`, `audio/mp4`, `video/quicktime`, `video/3gpp` | `ftyp` box, major brand `isom`, `mp42`, `M4A `, `qt  `, `3gp4` and kin | ISO/IEC 14496-12 §4.3; mp4ra.org brands |
| WebM, Matroska | `video/webm`, `video/x-matroska` | EBML header `1A 45 DF A3` and its DocType | RFC 8794; RFC 9559; WHATWG §6.2.2 |
| MP3 | `audio/mpeg` | `ID3`, or an MPEG audio frame header | ID3v2.4.0 §3.1; ISO/IEC 11172-3; WHATWG §6.2.3 |
| WAV | `audio/wav` | `RIFF`, 4 bytes, `WAVE` | WHATWG §6.2 |
| Ogg | `audio/ogg` | `OggS` and version 0 | RFC 3533 §6; WHATWG §6.2 |
| FLAC | `audio/flac` | `fLaC` | RFC 9639 §8 |
| PDF | `application/pdf` | `%PDF-` | ISO 32000-2 §7.5.2; WHATWG §7.1 |
| ZIP | `application/zip` | `PK 03 04`, or `PK 05 06` when empty | PKWARE APPNOTE §4.3.7, §4.3.16 |
| Word, Excel, PowerPoint | the Office Open XML types | a ZIP with an entry under `word/`, `xl/` or `ppt/` among the entries in the first 4 KiB | ECMA-376 Part 1 |
| OpenDocument, EPUB | the type in the archive | a ZIP whose first entry `mimetype` names it | ODF 1.3 Part 2 §3.3; EPUB OCF 3.3 §4.2.1 |
| Windows program | `application/vnd.microsoft.portable-executable` | `MZ` | Microsoft PE Format |
| Linux program | `application/x-executable` | `7F 45 4C 46` | System V ABI, ELF header |
| macOS program | `application/x-mach-binary` | Mach-O and universal binary magic numbers (also a Java class file) | Apple `mach-o/loader.h`, `mach-o/fat.h` |
| Script | `text/x-shellscript` | `#!` | `execve(2)` |
| SVG | `image/svg+xml` | a document whose root element, after any declaration, comment or doctype, is `svg` | SVG 2 |
| Web page | `text/html` | a tag such as `<html`, `<script`, `<div`, `<p`, `<!DOCTYPE html` or `<!--` at the start, or one of those tags as the root element | WHATWG §7.1 |
| XML | `application/xml` | `<?xml` | WHATWG §7.1 |

Text is read after a byte order mark (UTF-8 or UTF-16) and after leading whitespace, as a browser reads it.

### Limits

- **Only the start of the file is read.** Like a browser's own sniffing, the first bytes decide. A real PNG that
  carries HTML further in passes as a PNG: browsers display it as the image type it is stored with.
- **An XML type a route names may carry scripts.** Naming `image/svg+xml` or another XML type in `accept` takes
  documents a browser runs scripts in; the check does not look inside them. Serve such files from a domain of their
  own, or as downloads.
- **Archives are not opened.** A ZIP of programs passes as a ZIP. There is no virus scanning.
- **`deny` sees what the first bytes show.** A ZIP behind a one-byte prefix, which ZIP readers still open, shows no
  ZIP signature.
- **Text that starts like a web page is refused.** A Markdown file that opens with `<p align="center">`, `<div>` or a
  `<!--` comment reads as HTML, as a browser would read it.
- **It costs one ranged `GET` per completed file** (a Class B operation on R2), outside any database transaction. An
  empty file is not read: R2 answers any range of an empty object with `416` (measured 2026-11-21).

Rulings and their reasons: [M10-K](../decisions/m10-content.md).
