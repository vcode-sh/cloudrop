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
   (`application/x-msi`) and HTML applications (`application/hta`, a web page that Windows runs as a program). Also `unknown/unknown` and `application/unknown`, which a
   browser sniffs and may render as a page, and `multipart/x-mixed-replace`, whose parts a browser renders each by its
   own type, an HTML part as a page. `allow` lets a kind through, by any of its names.
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
   Word template or a macro-enabled document with a Word file, a WebM, MP4, 3GP, Matroska or Ogg file with its
   audio and its video types. A ZIP whose entries do not say what it is agrees with
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
| `detected` | The type the file's first bytes show, from the [table below](#what-it-recognises): for a container, the first of its types (`video/webm` for any WebM file). Present when the bytes decided; absent when the declared type alone was refused. |
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
| `allow` | Types let through rules 1 to 3, such as `["text/html"]` on a route that takes web pages on purpose. One name allows the kind under all its names (below). The route's `accept` and rules 4 and 5 still apply. | `[]` |
| `deny` | Types refused on every route: a file sent as one, at `/upload`, and a file whose first bytes show one, at `/complete`. Such as `["application/zip"]` or `["video/*"]`. Wins over `allow`. For audio and video containers and for ZIP, see [below](#containers). | `[]` |

Both take exact types or a top-level wildcard such as `"image/*"`, in lower case. Anything else throws
`INVALID_CONFIG` when `contentChecks()` is called.

A browser picks the name a file is sent under, and the check has one of its own for what the bytes show, so `allow`
goes by kind. Naming one type of a kind allows the kind under each of its names, at `/upload` and at `/complete`:

| Kind | Names |
| --- | --- |
| Web page | `text/html`, `application/xhtml+xml`, `application/hta` |
| Windows or DOS program | `application/vnd.microsoft.portable-executable`, `application/x-msdownload`, `application/x-msdos-program`, `application/x-dosexec`, `application/x-ms-dos-executable` |
| Linux program | `application/x-executable`, `application/x-elf`, `application/x-sharedlib` |
| macOS program | `application/x-mach-binary`, `application/x-mach-o-executable` |
| Script with a `#!` line | `text/x-shellscript`, `text/x-sh`, `application/x-sh`, `application/x-shellscript`, `application/x-perl`, `application/x-ruby`, `application/x-php` |
| JavaScript | every JavaScript type |
| Windows installer | `application/x-msi`, `application/x-ms-installer` |
| Unknown type | `unknown/unknown`, `application/unknown` |

So `allow: ["application/x-msdownload"]` takes a Windows program sent under any of the five names, and
`allow: ["application/xhtml+xml"]` an XHTML document, which the bytes show as a web page. An allowed type also covers
content that agrees with it: with `allow: ["application/rss+xml"]`, a feed sent as that type passes although its bytes
show plain XML, and with `allow: ["text/x-python"]`, a Python script with a `#!` line sent as that type. Allowing a
kind never allows a mismatch: an allowed program sent as `image/png` is still refused by rule 4.

```ts
// A site builder that takes HTML pages, but never plain ZIP archives.
contentChecks({ allow: ["text/html"], deny: ["application/zip"] });
```

A recognised package is its own type, not `application/zip`: `deny: ["application/zip"]` still lets a Word file, an
OpenDocument file or an EPUB through. Deny their types too when they must not pass.

#### Containers

WebM, Matroska, MP4, 3GP and Ogg files hold audio, video or both, and their first bytes do not say which. An ID3 tag
fronts MP3, AAC and FLAC files alike. Such a file is the type it was sent as, when its container can be that type:

```ts
// A voice recorder: MediaRecorder makes audio/webm, and Chrome sends an .m4a file as audio/x-m4a. Both pass.
route({ accept: "audio/*", maxSize: "20MB", authorize });
contentChecks({ deny: ["video/*"] });
```

So `deny: ["video/*"]` refuses every file sent as a video type, at `/upload`, and every file whose bytes show a
format that is only video (QuickTime) under another name. It does not refuse a WebM, MP4, 3GP, Matroska or Ogg file
sent as that container's audio type, with or without a video stream inside: telling them apart takes a parser for
each format, which this check is not. A container sent untyped is refused when `deny` names any type it can be:
nobody said which one it is. RIFF files are different: `WAVE` is audio and `WEBP` an image, and the bytes say so.

A ZIP that shows no package within the first 4 KiB is treated the same way. Sent as an Office, OpenDocument or `+zip`
type, it is that type, since ZIP is what such a file is: `deny: ["application/zip"]` refuses a ZIP sent as
`application/zip`, as `application/x-zip-compressed`, or as any type that is not built on ZIP, and not a document
whose `word/` folder starts past the bytes read. Anyone can put a `word/` entry into a ZIP, so `deny` never kept a
determined ZIP out of a route that takes Office files.

An OLE compound file is the container of Word, Excel and PowerPoint files before 2007, of Outlook messages, and of
Windows installers (`.msi`). Sent as an `application/` type other than an installer's, it passes as that type. Sent
untyped it is refused, since it may be an installer; `allow: ["application/x-msi"]` takes it.

The plugin applies to every route. A type that one route takes and another must not belongs in each route's `accept`.

### What it recognises

| Content | Type | Recognised by | Defined in |
| --- | --- | --- | --- |
| PNG, animated PNG | `image/png` (also agrees with `image/apng`) | `89 50 4E 47 0D 0A 1A 0A` | PNG Specification §5.2; WHATWG MIME Sniffing §6.1 |
| JPEG | `image/jpeg` | `FF D8 FF` | ITU-T T.81 Annex B; WHATWG §6.1 |
| GIF | `image/gif` | `GIF87a`, `GIF89a` | GIF89a specification §17; WHATWG §6.1 |
| WebP | `image/webp` | `RIFF`, 4 bytes, `WEBPVP` | RFC 9649 §2.5; WHATWG §6.1 |
| AVIF, HEIC, HEIF | `image/avif`, `image/heic`, `image/heif` | ISO BMFF `ftyp` box, major brand `avif`, `heic` and kin, `mif1` | AVIF §9.1; ISO/IEC 23008-12 |
| MP4, M4A, MOV, 3GP | `video/mp4` (also `audio/mp4`, `audio/x-m4a`), `audio/mp4`, `video/quicktime`, `video/3gpp` (also `audio/3gpp`) | `ftyp` box, major brand `isom`, `mp42`, `M4A `, `qt  `, `3gp4` and kin | ISO/IEC 14496-12 §4.3; mp4ra.org brands |
| WebM, Matroska | `video/webm` (also `audio/webm`), `video/x-matroska` (also `audio/x-matroska`) | EBML header `1A 45 DF A3` and its DocType | RFC 8794; RFC 9559; WHATWG §6.2.2 |
| MP3, and any file an ID3 tag fronts | `audio/mpeg` (an ID3 tag also `audio/aac`, `audio/vnd.dlna.adts`, `audio/flac`, `audio/mp2`) | an ID3v2 header (`ID3`, version 2 to 4, a revision under `FF`, flags with the low four bits clear, a size of four bytes under `80`), or a Layer III frame header with a second one where its frame ends | ID3v2.4.0 §3.1; ISO/IEC 11172-3; WHATWG §6.2.3 |
| WAV | `audio/wav` | `RIFF`, 4 bytes, `WAVE` | WHATWG §6.2 |
| Ogg | `audio/ogg` (also `video/ogg`, `audio/opus`, `application/ogg`) | `OggS` and version 0 | RFC 3533 §6; WHATWG §6.2 |
| FLAC | `audio/flac` | `fLaC` | RFC 9639 §8 |
| PDF | `application/pdf` | `%PDF-` | ISO 32000-2 §7.5.2; WHATWG §7.1 |
| Old Office file or Windows installer | `application/x-ole-storage` | `D0 CF 11 E0 A1 B1 1A E1` | MS-CFB §2.2 |
| ZIP | `application/zip` | `PK 03 04`, or `PK 05 06` when empty | PKWARE APPNOTE §4.3.7, §4.3.16 |
| Word, Excel, PowerPoint | the Office Open XML types | a ZIP with an entry under `word/`, `xl/` or `ppt/` among the entries in the first 4 KiB, also after entries whose sizes follow their data (streamed archives, as Java and Node writers make them), in 4 bytes each or in ZIP64's 8, as Apache POI's streaming workbook writes them | ECMA-376 Part 1; PKWARE APPNOTE §4.3.9, §4.4.4 |
| OpenDocument, EPUB | the type in the archive | a ZIP whose first entry `mimetype` names it | ODF 1.3 Part 2 §3.3; EPUB OCF 3.3 §4.2.1 |
| Windows or DOS program | `application/vnd.microsoft.portable-executable` | `MZ`, then `PE\0\0`, `NE`, `LE` or `LX` where the offset at `0x3C` points (past the first 4 KiB, an offset under 151 MB in a file long enough to hold it), or a DOS header with fewer than 512 bytes on its last page and a header of at least two paragraphs that fits in its pages | Microsoft PE Format; The MS-DOS Encyclopedia, Article 4 |
| Linux program | `application/x-executable` | `7F 45 4C 46` | System V ABI, ELF header |
| macOS program | `application/x-mach-binary` | Mach-O and universal binary magic numbers (also a Java class file) | Apple `mach-o/loader.h`, `mach-o/fat.h` |
| Script | `text/x-shellscript` | `#!`, any spaces or tabs, then `/`, at the start or behind a byte order mark or blank lines | `execve(2)`; POSIX.1-2024 Shell Command Language §2.9.1.4 |
| SVG | `image/svg+xml` | a document whose root element, after any declaration, comment or doctype, is `svg`; the doctype ends where an XML parser ends it, so a `>` or `]>` inside a quoted value, a comment or a processing instruction does not end it | SVG 2; XML 1.0 §2.8 |
| Web page | `text/html` | one of the standard's tags (`<!DOCTYPE html`, `<html`, `<head`, `<script`, `<iframe`, `<h1`, `<div`, `<font`, `<table`, `<a`, `<style`, `<title`, `<b`, `<body`, `<br`, `<p`) or `<hta:application` at the start, in any case, before a space or `>`; also before a tab, a line break or `/`; also as the root after a comment or a doctype in a document without `<?xml`; an `html` root; or `<!--` at the start, whatever follows | WHATWG §7.1 |
| XML | `application/xml` | `<?xml`, or a doctype other than `html` that is still open where the first 4 KiB end | WHATWG §7.1; XML 1.0 §2.8 |

Text is read after a byte order mark (UTF-8 or UTF-16) and after the standard's whitespace bytes (tab, line feed, form
feed, carriage return, space). A tag is its whole name: `<a,b>`, `<a@b.com>` and `<br2>` are not tags. The standard
asks for a space or `>` after `<!--` too; Chromium and Firefox take it before any byte, and so does the check.

A browser's HTML parser ends a doctype at its first `>`, quoted or not, where an XML parser reads on. A document
without `<?xml` may reach either, so the check reads its doctype both ways and the root either reading finds decides:
`<!DOCTYPE x [<!ENTITY a "]>">]><svg onload=…>` is an SVG, and `<!DOCTYPE x "><script>…` is a web page.

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
- **Some files a system runs show no signature.** Each of these passes as the type it was sent as, or untyped: Windows
  batch files and PowerShell scripts (`.bat`, `.cmd`, `.ps1`), VBScript and JScript files (`.vbs`, `.js`), internet
  shortcuts (`.url`, a text file), Windows shortcuts (`.lnk`, which this check does not recognise), DOS `.com`
  programs, which have no header at all, and an HTML application (`.hta`) that starts with none of the tags in the
  table. Keep `application/octet-stream` and broad text types out of `accept` where such files must not land, and
  do not serve stored files to be opened.
- **An installer sent as an old Office type passes.** An `.msi` and a `.doc` from before 2007 start with the same
  bytes, so an installer sent as `application/msword` is taken for a document. Only an untyped one, or one sent as
  an installer type, is refused.
- **A spreadsheet export that is HTML or XML inside is refused.** Many applications' "Export to Excel" writes an HTML
  table into a file named `.xls`, and Excel 2003 saves XML. Sent as `application/vnd.ms-excel`, the first is refused
  as a web page and the second as XML; the same holds for `application/msword`. To take them, add
  `allow: ["application/vnd.ms-excel"]`: both then pass as that type, which a browser downloads and does not render.
- **Archives are not opened.** A ZIP of programs passes as a ZIP. There is no virus scanning.
- **`deny` sees what the first bytes show.** A ZIP behind a one-byte prefix, which ZIP readers still open, shows no
  ZIP signature. A video in a WebM, MP4 or Ogg file sent as an audio type is not told from a recording
  ([Containers](#containers)).
- **A text file that starts with `#!` and a path is refused as a script,** even on a route that takes `text/*`, and
  so is other text that opens with `#!/`, such as a list of hash-bang URLs. The line counts behind a byte order mark
  or blank lines too: the kernel does not run such a file, but a shell does, as a shell script. A route that takes source code adds
  `allow: ["text/x-shellscript"]`; an allowed script then passes as any text type, such as `text/x-python` or
  `text/plain`, or as `application/x-sh`, `application/x-perl`, `application/x-ruby` or `application/x-php`.
- **Text that starts like a web page is refused.** A Markdown file that opens with `<p align="center">`, `<div>` or a
  `<!--` comment reads as HTML, as a browser would read it. So does an SVG whose comments before the `<svg` root fill
  the first 4 KiB, even on a route that names `image/svg+xml`.
- **A doctype longer than the first 4 KiB hides the root element.** Such a file reads as an XML document, whatever
  its root is: it is refused unless it was sent as an XML type the route names, and an SVG sent as `image/svg+xml` to
  a route that names it passes as before. `deny: ["image/svg+xml"]` does not see it on a route that names another XML
  type.
- **It costs one ranged `GET` per completed file** (a Class B operation on R2), outside any database transaction. An
  empty file is not read: R2 answers any range of an empty object with `416` (measured 2026-11-21).

Rulings and their reasons: [M10-K](../decisions/m10-content.md).
