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
   `text/jscript` and the rest), the shell script types and `text/vbscript`, and Windows installers
   (`application/x-msi`) and HTML applications (`application/hta`). Also `unknown/unknown` and `application/unknown`, which a
   browser sniffs and may render as a page, and `multipart/x-mixed-replace`, whose parts a browser renders each by its
   own type, an HTML part as a page. `allow` lets a type through.
2. **An XML type the route does not name.** A browser renders XML, and runs the scripts an SVG or an XHTML element in
   it carries. `text/xml`, `application/xml`, `text/xsl` and every `+xml` type, `image/svg+xml` among them, pass only
   when the route's `accept` lists that exact type, such as `accept: ["image/png", "image/svg+xml"]`; `image/*` and
   `*/*` are not enough. `allow` lets a type through.

A refusal at `/upload` refuses the whole request, as any `beforeUpload` refusal does.

At `/complete`, a file whose **first bytes show**:

3. **A web page, a program, a script, or XML the route does not name**, whatever the file was sent as. The declared
   type is judged again here, for an upload signed before the plugin was installed or its lists changed.
4. **A type that contradicts the declared type.** A JPEG sent as `image/png`, a PDF sent as `text/plain`, a ZIP sent as
   an image. A content type agrees with its common aliases: `audio/x-wav` with a WAV, `image/heif` with a HEIC, a
   Word template or a macro-enabled document with a Word file. A ZIP whose entries do not say what it is agrees with
   any `application/` or `model/` type, since many formats are ZIP archives (APK, JAR, Visio, 3MF); a ZIP sent as
   `application/pdf` passes for the same reason, while one sent as an image or a font does not.
5. **For a file the browser could not type, a type the route does not accept.** Such a file is sent as
   `application/octet-stream`, which is not a contradiction; the content's own type must then be in `accept`.

A file whose first bytes match none of the formats below passes as the type it was sent as, which the route accepted
and rule 1 and 2 let through. Plain text, CSV, JSON and most text formats have no signature, so they pass this way.
JavaScript has none either: a script is refused by its declared type, or by a `#!` line naming its interpreter.

### What happens to a refused file

A refusal at `/upload` signs and stores nothing; only the plugins listed before `contentChecks()` hear `onAbort`, for
what their own `beforeUpload` reserved. A refusal at `/complete` is an `afterVerify` refusal, handled like any other
(see [Plugin hooks](server.md#plugin-hooks)):

- The client gets `FILE_TYPE_NOT_ALLOWED` (400, not retryable) with a message for the person, such as "This file is a
  JPEG image, but it was sent as image/png. Give it the right extension, or pick another file." or "This file is a
  web page (HTML), which this upload does not accept. Pick another file."
- The object is deleted, only when it is this upload's.
- Every plugin's `onAbort` runs with `reason: "rejected"`.
- With a [database store](store.md), the file's row ends `rejected` before the object is deleted, and the owner's
  reserved bytes are released. A retried `/complete` answers `UPLOAD_EXPIRED`; nothing is ever `completed`.

When the bucket cannot be read, the object is kept and the client gets a retryable `SERVER_ERROR`; it completes again
on its own.

### What a refusal carries

The message is English. An app that words its errors itself, or translates them, reads `error.content` instead, which
every refusal of `contentChecks()` carries to the client beside `code`, `message` and `retryable`:

```ts
error.content; // { declared: "image/png", detected: "image/jpeg", reason: "mismatch" }
```

| Field | What it holds |
| --- | --- |
| `declared` | The type the file was sent as: the browser's type for it, or `application/octet-stream` when the browser had none. |
| `detected` | The type the file's first bytes show, from the [table below](#what-it-recognises). Present when the bytes decided; absent when the declared type alone was refused. |
| `reason` | Why the file was refused: one of the three below. |

| `reason` | Rules | What it means | `detected` |
| --- | --- | --- | --- |
| `"refused"` | 1, 2, 3 and `deny` | The file is a kind this server refuses: a web page, a program, a script, an XML type the route does not name, or a `deny` entry. The refused type is `detected`, or `declared` when there is no `detected`. | At `/upload`, never. At `/complete`, present unless the declared type itself was refused. |
| `"mismatch"` | 4 | The content is `detected`, but the file was sent as `declared`. | Always. |
| `"not-accepted"` | 5 | The browser could not type the file, and its content, `detected`, is not a type the route accepts. | Always. |

A refusal at `/upload` refuses the whole request, so there `declared` is the type of the first refused file in it, not
of each file that failed with it; the error then has no `error.file`. `content` holds these three values and nothing
else: never a file name, a key or a byte of the file. An older client ignores it, and the route's own `accept` refusal
(a type not in `accept`, without the plugin) carries none, so keep `error.message` as the fallback. Building your own
copy from it in React: [Errors to show](react.md#errors-to-show).

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
// A site builder that takes HTML pages, but never plain ZIP archives.
contentChecks({ allow: ["text/html"], deny: ["application/zip"] });
```

A recognised package is its own type, not `application/zip`: `deny: ["application/zip"]` still lets a Word file, an
OpenDocument file or an EPUB through. Deny their types too when they must not pass.

The plugin applies to every route. A type that one route takes and another must not belongs in each route's `accept`.

### What it recognises

| Content | Type | Recognised by | Defined in |
| --- | --- | --- | --- |
| PNG, animated PNG | `image/png` (also agrees with `image/apng`) | `89 50 4E 47 0D 0A 1A 0A` | PNG Specification §5.2; WHATWG MIME Sniffing §6.1 |
| JPEG | `image/jpeg` | `FF D8 FF` | ITU-T T.81 Annex B; WHATWG §6.1 |
| GIF | `image/gif` | `GIF87a`, `GIF89a` | GIF89a specification §17; WHATWG §6.1 |
| WebP | `image/webp` | `RIFF`, 4 bytes, `WEBPVP` | RFC 9649 §2.5; WHATWG §6.1 |
| AVIF, HEIC, HEIF | `image/avif`, `image/heic`, `image/heif` | ISO BMFF `ftyp` box, major brand `avif`, `heic` and kin, `mif1` | AVIF §9.1; ISO/IEC 23008-12 |
| MP4, M4A, MOV, 3GP | `video/mp4`, `audio/mp4`, `video/quicktime`, `video/3gpp` | `ftyp` box, major brand `isom`, `mp42`, `M4A `, `qt  `, `3gp4` and kin | ISO/IEC 14496-12 §4.3; mp4ra.org brands |
| WebM, Matroska | `video/webm`, `video/x-matroska` | EBML header `1A 45 DF A3` and its DocType | RFC 8794; RFC 9559; WHATWG §6.2.2 |
| MP3 | `audio/mpeg` | an ID3v2 header (`ID3`, version 2 to 4, a revision under `FF`, flags with the low four bits clear, a size of four bytes under `80`), or an MPEG audio frame header | ID3v2.4.0 §3.1; ISO/IEC 11172-3; WHATWG §6.2.3 |
| WAV | `audio/wav` | `RIFF`, 4 bytes, `WAVE` | WHATWG §6.2 |
| Ogg | `audio/ogg` | `OggS` and version 0 | RFC 3533 §6; WHATWG §6.2 |
| FLAC | `audio/flac` | `fLaC` | RFC 9639 §8 |
| PDF | `application/pdf` | `%PDF-` | ISO 32000-2 §7.5.2; WHATWG §7.1 |
| ZIP | `application/zip` | `PK 03 04`, or `PK 05 06` when empty | PKWARE APPNOTE §4.3.7, §4.3.16 |
| Word, Excel, PowerPoint | the Office Open XML types | a ZIP with an entry under `word/`, `xl/` or `ppt/` among the entries in the first 4 KiB | ECMA-376 Part 1 |
| OpenDocument, EPUB | the type in the archive | a ZIP whose first entry `mimetype` names it | ODF 1.3 Part 2 §3.3; EPUB OCF 3.3 §4.2.1 |
| Windows or DOS program | `application/vnd.microsoft.portable-executable` | `MZ`, then `PE\0\0`, `NE`, `LE` or `LX` where the offset at `0x3C` points (past the first 4 KiB, an offset under 151 MB in a file long enough to hold it), or a DOS header with fewer than 512 bytes on its last page and a header of at least two paragraphs that fits in its pages | Microsoft PE Format; The MS-DOS Encyclopedia, Article 4 |
| Linux program | `application/x-executable` | `7F 45 4C 46` | System V ABI, ELF header |
| macOS program | `application/x-mach-binary` | Mach-O and universal binary magic numbers (also a Java class file) | Apple `mach-o/loader.h`, `mach-o/fat.h` |
| Script | `text/x-shellscript` | `#!`, any spaces or tabs, then `/` | `execve(2)` |
| SVG | `image/svg+xml` | a document whose root element, after any declaration, comment or doctype, is `svg` | SVG 2 |
| Web page | `text/html` | one of the standard's tags (`<!DOCTYPE html`, `<html`, `<head`, `<script`, `<iframe`, `<h1`, `<div`, `<font`, `<table`, `<a`, `<style`, `<title`, `<b`, `<body`, `<br`, `<p`) at the start, in any case, before a space or `>`; also before a tab, a line break or `/`; also as the root after a comment or a doctype in a document without `<?xml`; an `html` root; or `<!--` at the start, whatever follows | WHATWG §7.1 |
| XML | `application/xml` | `<?xml` | WHATWG §7.1 |

Text is read after a byte order mark (UTF-8 or UTF-16) and after the standard's whitespace bytes (tab, line feed, form
feed, carriage return, space). A tag is its whole name: `<a,b>`, `<a@b.com>` and `<br2>` are not tags. The standard
asks for a space or `>` after `<!--` too; Chromium and Firefox take it before any byte, and so does the check.

### Limits

- **Only the start of the file is read.** Like a browser's own sniffing, the first bytes decide. A real PNG that
  carries HTML further in passes as a PNG: browsers display it as the image type it is stored with.
- **An XML type a route names may carry scripts.** Naming `image/svg+xml` or another XML type in `accept` takes
  documents a browser runs scripts in; the check does not look inside them. Serve such files from a domain of their
  own, or as downloads.
- **Serve stored files with `X-Content-Type-Options: nosniff`.** A file with no signature passes as the text type it
  was sent as: JavaScript sent as `text/plain` to a route that takes `text/plain` is stored. Without `nosniff`, a
  page may still load such a file with `<script src>` from your origin; the `attachment` disposition cloudrop stores
  stops a browser opening it as a page, not that. Better still, serve user files from a domain of their own.
- **Windows batch files and PowerShell scripts have no signature.** A `.bat`, `.cmd` or `.ps1` sent as a text type or
  as `application/octet-stream` passes; keep those types out of `accept` and do not serve such files to be opened.
- **Archives are not opened.** A ZIP of programs passes as a ZIP. There is no virus scanning.
- **`deny` sees what the first bytes show.** A ZIP behind a one-byte prefix, which ZIP readers still open, shows no
  ZIP signature.
- **A text file that starts with `#!` and a path is refused as a script,** even on a route that takes `text/*`, and
  so is other text that opens with `#!/`, such as a list of hash-bang URLs. A route that takes source code adds
  `allow: ["text/x-shellscript"]`; an allowed script then passes as any text type, such as `text/x-python` or
  `text/plain`, or as `application/x-sh`, `application/x-perl`, `application/x-ruby` or `application/x-php`.
- **Text that starts like a web page is refused.** A Markdown file that opens with `<p align="center">`, `<div>` or a
  `<!--` comment reads as HTML, as a browser would read it. So does an SVG whose comments before the `<svg` root fill
  the first 4 KiB, even on a route that names `image/svg+xml`.
- **It costs one ranged `GET` per completed file** (a Class B operation on R2), outside any database transaction. An
  empty file is not read: R2 answers any range of an empty object with `416` (measured 2026-11-21).

Rulings and their reasons: [M10-K](../decisions/m10-content.md).
