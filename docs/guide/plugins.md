# Plugins

`cloudrop/plugins` holds the plugins cloudrop ships for `createCloudrop({ plugins })`. They run on the server only and
add nothing to the client. Today there is one, `contentChecks()`. To write your own, see
[Plugin hooks](server.md#plugin-hooks).

## contentChecks()

The browser declares a file's type, and `accept` checks that declaration, not the file. Without a check of the bytes,
a page can upload a web page or a program as `image/png`, and the bucket stores it with that type. `contentChecks()`
reads the first 4 KiB of every uploaded file at `/complete` and refuses one whose content is not what it was sent as.

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

In this order, on every route:

1. **Web pages, programs and scripts, whatever they were sent as.** A file whose content or declared type is HTML or
   XHTML, a Windows, Linux or macOS program, JavaScript or a script with a `#!` line. `allow` lets a type through.
2. **XML and SVG on a route that does not name the type.** A browser renders them, and runs the scripts an SVG or an
   XHTML element carries. They pass only when the route's `accept` lists the exact type the file was sent as, such as
   `accept: ["image/png", "image/svg+xml"]`; `image/*` and `*/*` are not enough.
3. **Content that contradicts the declared type.** A JPEG sent as `image/png`, a PDF sent as `text/plain`. A content
   type agrees with its common aliases: `audio/x-wav` with a WAV, `image/heif` with a HEIC, any ZIP-based office
   type with a ZIP whose entries do not say which one it is.
4. **An untyped file whose content the route does not accept.** A browser that cannot type a file sends it as
   `application/octet-stream`, which is not a contradiction; the content's own type must then be in `accept`.

A file whose first bytes match none of the formats below passes as the type it was sent as, which the route already
accepted at `/upload`, unless rule 1 or 2 refuses that type. Plain text, CSV, JSON and most other text formats have no
signature, so they always pass this way.

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

### Options

| Option | What it does | Default |
| --- | --- | --- |
| `allow` | Types let through rule 1 and 2, such as `["text/html"]` on a route that takes web pages on purpose. The route's `accept` and rule 3 still apply. | `[]` |
| `deny` | Types refused on every route, by content or declared type, such as `["application/zip"]` or `["video/*"]`. Wins over `allow`. | `[]` |

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
| Word, Excel, PowerPoint | the Office Open XML types | a ZIP with an entry under `word/`, `xl/` or `ppt/` | ECMA-376 Part 1 |
| OpenDocument, EPUB | the type in the archive | a ZIP whose first entry `mimetype` names it | ODF 1.3 Part 2 §3.3; EPUB OCF 3.3 §4.2.1 |
| Windows program | `application/vnd.microsoft.portable-executable` | `MZ` | Microsoft PE Format |
| Linux program | `application/x-executable` | `7F 45 4C 46` | System V ABI, ELF header |
| macOS program | `application/x-mach-binary` | Mach-O and universal binary magic numbers (also a Java class file) | Apple `mach-o/loader.h`, `mach-o/fat.h` |
| Script | `text/x-shellscript` | `#!` | `execve(2)` |
| Web page | `text/html` | a tag such as `<html`, `<script`, `<div`, `<!DOCTYPE html` or `<!--` at the start, or an XHTML document | WHATWG §7.1 |
| SVG | `image/svg+xml` | an XML document whose root element is `svg` or that uses the SVG namespace | SVG 2 |
| XML | `application/xml` | `<?xml` | WHATWG §7.1 |

Text is read after a byte order mark (UTF-8 or UTF-16) and after leading whitespace, as a browser reads it.

### Limits

- **Only the start of the file is read.** Like a browser's own sniffing, the first bytes decide. A real PNG that
  carries HTML further in passes as a PNG: browsers display it as the image type it is stored with. An XML document
  whose prolog runs past 4 KiB is judged by what was read.
- **Archives are not opened.** A ZIP of programs passes as a ZIP. There is no virus scanning.
- **Text that starts like a web page is refused.** A Markdown file that opens with `<div align="center">` reads as
  HTML, as a browser would read it.
- **It costs one ranged `GET` per completed file** (a Class B operation on R2), outside any database transaction. An
  empty file is not read: R2 answers any range of an empty object with `416` (measured 2026-11-21).

Rulings and their reasons: [M10-K](../decisions/m10-content.md).
