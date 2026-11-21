# M10-K: content checks

Rulings for `cloudrop/plugins` and `contentChecks()`, designed in `docs/superpowers/specs/2026-11-21-0.4.0-design.md`.
Entries continue from 1.

### M10-K1: the type from the first 4 KiB, by each format's own signature

- **Decision:** at `/complete`, `contentChecks()` reads bytes `0` to `min(size, 4096) - 1` of the stored file with
  `storage.getRange` and detects one of: PNG, JPEG, GIF, WebP, WAV, PDF, Ogg, FLAC, MP3 (an ID3v2 header, M10-K10, or
  an MPEG audio frame header), the ISO BMFF brands (AVIF, HEIC and HEIF, MP4, M4A, QuickTime, 3GPP), the EBML DocType
  (WebM, Matroska), ZIP and the packages inside it (Office Open XML by an entry under `word/`, `xl/` or `ppt/`,
  OpenDocument and EPUB by their first `mimetype` entry), Windows and DOS, Linux and macOS programs (an MS-DOS header,
  M10-K10; ELF; Mach-O and universal binaries), a `#!` line naming an interpreter's path (M10-K11), and as text after
  a UTF-8 or UTF-16 byte order mark and leading whitespace: SVG (an `svg` root element after the prolog), HTML
  (WHATWG's tags at the start, an `html` root, or one of the tags as the unprefixed root of a document without an XML
  declaration) and XML (`<?xml`). Each row cites its specification in `src/plugins/sniff*.ts`; the table with sources
  is in [Plugins](../guide/plugins.md#what-it-recognises). A detection carries the declared types it agrees with:
  aliases; each Office application's own Open XML and Microsoft types (templates, slide shows, macro-enabled files);
  any `application/` or `model/` type for a ZIP whose entries name no package; `+xml` types for XML.
- **Why:** these are the formats upload forms take and the ones that do harm when mislabelled. Only the start decides,
  as in a browser's own sniffing (WHATWG MIME Sniffing §7.1), so the check refuses what a browser would treat as
  HTML, not every file that mentions a tag. Choices that keep real files: an ISO BMFF file counts only when its major
  brand is known (a camera's raw file compatible with `isom` is not a video); an MPEG audio header is not read after
  a byte order mark (UTF-16LE text starting with `h` forms a valid one); the root element is read before the HTML
  tags, so an SVG that opens with a generator's comment is an SVG; a ZIP is the container of many formats (APK, JAR,
  Visio, 3MF), so an unnamed one contradicts every type outside `application/` and `model/` (a ZIP sent as `application/pdf`
  passes; one sent as an image or a font does not). XML namespaces are not read: a
  character reference spells one as well as the URI does, so a check of them would promise what it cannot keep
  (M10-K9). The HTML tag must end in whitespace, `>` or `/`, a little wider than WHATWG's space or `>`: a parser reads
  those the same.
- **If wrong:** a format that starts with one of these signatures by chance would be refused as a contradiction; none
  is known among the types `accept.ts` lists. A signature short enough for text to start with is read with its header
  fields (M10-K10, M10-K11).
- **Status:** in force. `src/plugins/sniff.test.ts` holds one vector per signature and the near misses.
- **Visible in:** `src/plugins/sniff.ts`, `src/plugins/sniff-containers.ts`, `src/plugins/sniff-text.ts`,
  `docs/guide/plugins.md`.

### M10-K2: the declared type at `/upload`, the content at `/complete`

- **Decision:** a `beforeUpload` hook refuses a request when a file in it was sent as a type M10-K3 refuses, before
  anything is signed. An `afterVerify` hook then judges, first match wins: (0) the declared type again, for a token
  signed before the plugin or its lists changed (tokens live 24 hours); (1) the detected type is one M10-K3 refuses; (2) it contradicts a declared type other than `application/octet-stream`; (3) the declared type is
  `application/octet-stream` and no type the content agrees with is in `accept`. Content that matches no signature
  passes as its declared type.
- **Why:** checking only at `/complete` signed a `PUT` for a file sent as `text/html`; a page that never called
  `/complete` left it in the bucket, served as a page from a public route (review finding, 2026-11-21). Refused
  before signing, such a file never reaches the bucket. A declared type that agrees with the content was accepted at
  `/upload`, so "not in `accept`" can only happen when the browser could not type the file: then there is nothing to
  contradict and the content's own type is checked. `beforeUpload` refuses the whole request, the one granularity the
  hook has: such a request comes from a page that offers a type the route must not take.
- **If wrong:** a route that accepts `application/octet-stream` alone, to take files the browser cannot type, refuses
  an untyped PNG; it lists the content types it takes instead. A content mismatch is still found only at `/complete`:
  an object never completed stays, under a declared type `/upload` let through, until the lifecycle rule or the sweep.
- **Status:** in force; `src/plugins/content-checks.test.ts`, `src/plugins/content-checks-upload.test.ts`.
- **Visible in:** `src/plugins/content-checks.ts`.

### M10-K3: web pages, programs and scripts are refused by default; XML needs its type named

- **Decision:** refused whatever the route accepts: `text/html`, `application/xhtml+xml`, WHATWG's unknown types
  (`unknown/unknown`, `application/unknown`), `multipart/x-mixed-replace`, the program types
  (`application/vnd.microsoft.portable-executable`, `application/x-msdownload`, `application/x-msdos-program`,
  `application/x-dosexec`, `application/x-executable`, `application/x-elf`, `application/x-sharedlib`,
  `application/x-mach-binary`, `application/x-mach-o-executable`, and the Windows installer and HTML application types
  `application/x-msi`, `application/x-ms-installer`, `application/hta`), every JavaScript MIME type essence of WHATWG
  MIME Sniffing §4.6, the shell script types (`text/x-shellscript`, `application/x-sh`, `application/x-shellscript`,
  `text/x-sh`) and `text/vbscript`. A Windows installer's content (an OLE compound file) is detected only as that
  container, which Word and Excel files before 2007 share: sent untyped it passes as what it was sent as (`M11-R254`, which took back the refusal of `M11-R136`). Every XML type (`text/xml`, `application/xml`, `text/xsl` and any `+xml`, SVG
  among them) passes only when the file was sent as an XML type that the route's `accept` lists exactly. `allow` lifts
  these refusals per type; `deny` adds to them and wins over `allow`.
- **Why:** the design names HTML, executables, scripts and SVG. The SVG rule is widened to every XML type because a
  browser renders `text/xml`, `text/xsl` and `application/rss+xml` too, and an element in the SVG or XHTML namespace
  runs its scripts there; "named exactly" means `image/*` or `*/*` let no XML through by accident. A browser sniffs the
  unknown types (WHATWG §7) and may render the file as a page. A browser navigated to a `multipart/x-mixed-replace`
  response renders each body part as a document of the part's own type (HTML Standard §7.5.5, Loading
  `multipart/x-mixed-replace` documents; §17.2 names `text/html` parts as its security concern), and Firefox does
  (review finding, 2026-11-21). An object cloudrop signs is stored with the type's essence only, without the `boundary`
  parameter §17.2 requires, and a reviewer reading Firefox's `nsMultiMixedConv` found it refuses such a response; the
  refusal is kept as defence in depth, for an app that serves stored files under a header of its own and for any later
  change that keeps parameters. Nothing legitimate is uploaded as this type.
- **If wrong:** a route that takes RSS or other XML on purpose lists the type in `accept`; one that takes HTML adds it
  to `allow` and `accept`.
- **Status:** in force.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/guide/plugins.md`.

### M10-K4: a refusal is `FILE_TYPE_NOT_ALLOWED`; no new code

- **Decision:** every refusal is `FILE_TYPE_NOT_ALLOWED` (400, not retryable) with one of four messages: at
  `/upload`, "One of the files was sent as <type>, which this upload does not accept. Pick another file."; at
  `/complete`, "This file was sent as <type>, which …" (a token signed before the plugin), "This file is <what it
  is>, which this upload does not accept. Pick another file." or "This file is
  <what it is>, but it was sent as <declared type>. Give it the right extension, or pick another file." What it is comes
  from the detection table ("a JPEG image", "a program"); the declared type is the normalized MIME type `/upload`
  signed. A failure to read the bucket throws, which the handler answers as the retryable `SERVER_ERROR` it gives any
  failing `afterVerify`, keeping the object.
- **Why:** the code already means "this file's type is not allowed here" at `/upload`, which is what the person must
  hear; an app showing it needs no new branch. `VERIFICATION_FAILED` means the stored size or type differs from the
  token, which is not this case. A message names what the file was sent as when only that is known, and what the bytes
  show when they decide. It never names the file: the name is the client's text, which messages do not echo
  (`accept.ts` echoes an extension only when it is plain), and the page that sent the request knows its files. The client drops a non-retryable failure and asks `/upload` for a new ticket on `retry()`, so
  no client change is needed. A read failure says nothing about the file, so it must not refuse it.
- **If wrong:** an app that must tell a refusal at `/upload` from one at `/complete` reads the endpoint from where the
  error surfaced; a code of its own would be a new public code.
- **Status:** in force; `docs/guide/errors.md`.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/guide/errors.md`.

### M10-K5: `cloudrop/plugins` is built apart and imports `CloudropError` from `cloudrop`

- **Decision:** `src/plugins.ts` is a new entry, built like `cloudrop/testing` in a configuration of its own whose
  imports of `src/index.ts` become imports of `./index.js` (`tsdown.config.ts`, `apart("plugins")`). It holds only the
  plugins and the code they need (`accept-entry.ts`, split from `accept.ts` so its extension table stays out). Its
  size-limit budget counts its own file: 6 kB gzip. `scripts/check-package.sh` fails when `dist/testing.js` or
  `dist/plugins.js` defines `CloudropError` or does not import `./index.js`.
- **Why:** the server checks a plugin's refusal with `instanceof CloudropError` (`runAfterVerify`); a copy of the class
  would turn every refusal into a server error. Building it with the library's entries would move shared modules into
  chunks and change every entry's size (M9-T2). No other entry imports it, so a server without plugins ships none of
  it.
- **If wrong:** a plugin that needs another class from the server is imported the same way, through `src/index.ts`.
- **Status:** in force.
- **Visible in:** `src/plugins.ts`, `tsdown.config.ts`, `scripts/size-limit.config.ts`, `scripts/check-package.sh`,
  `package.json` exports.

### M10-K6: what runs where

- **Decision:** the content check is an `afterVerify` hook, so it runs at `/complete` after the server verified the
  object (or completed the multipart upload) and before `onComplete`, outside any database transaction. With a store,
  the refusal path that already exists ends the row `rejected` first and deletes the object only when that change was
  this request's; the store releases the owner's reserved bytes with the row; every plugin's `onAbort` runs with
  `"rejected"`. Stateless, the object is deleted and `onAbort` runs; a failed delete answers the storage error and keeps
  the object, so a retry checks it again. An empty file is not read.
- **Why:** these are the guarantees every `afterVerify` refusal already has (M5 spec §5.5), proven for content checks
  in lease and transaction mode, single PUT and multipart (`content-checks-store.test.ts`, and stateless multipart in
  `content-checks.test.ts`). R2 answers a range of an empty object with `416 InvalidRange` and serves a range past a
  short object's end clamped to it (measured 2026-11-21: 0 bytes `416`; 1, 100, 4,096 and 5,000 bytes `206` with
  `content-range` ending at the last byte or at 4,095); the fake R2 does the same, and the live lane runs the plugin on
  0-byte, 1-byte and 5 KiB files.
- **If wrong:** a backend that ignores `Range` and sends a whole object would make the read cost the object's size;
  the bytes are cut to 4 KiB, but the transfer is not. R2, RustFS, Wrangler and S3 honour it.
- **Status:** in force; `src/plugins/content-checks.r2.integration.test.ts` in `bun run test:live`.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/research/r2-spike-findings.md`.

### M10-K7: `beforeUpload` and `afterVerify` receive the route's `accept`

- **Decision:** `BeforeUploadContext` and `AfterVerifyContext` gain `accept: readonly string[]`, the route's entries as
  `createCloudrop` read them. `checkAfterVerify` takes the route's configuration from its callers instead of looking
  it up again. A public type gets a new required field, which only code that builds a context by hand (a plugin's own
  tests) must add.
- **Why:** M10-K3 needs to know whether the route names a type exactly or lets it in through a wildcard; the route's
  definition, which `extendRoute` sees, holds `accept` before it is normalized. Any plugin that checks types needs it.
- **If wrong:** a plugin that wants the rest of the route's configuration asks for it the same way.
- **Status:** in force.
- **Visible in:** `src/server/plugins.ts`, `src/server/upload.ts`, `src/server/complete-steps.ts`,
  `docs/guide/server.md`.

### M10-K8: two options, checked when the plugin is made

- **Decision:** `contentChecks({ allow?, deny? })`, each a list of lower-case MIME types or top-level wildcards (the
  syntax of `accept`, without parameters). Anything else throws `INVALID_CONFIG` from `contentChecks()` itself. The
  plugin's id is `"content-checks"`. No quarantine, scanner or per-route option.
- **Why:** the design keeps the options small. Checking them when the plugin is made fails a deploy at start-up rather
  than on a user's upload, as `createCloudrop` does for its own options. A per-route rule already exists: the route's
  `accept`.
- **If wrong:** an app that needs different `allow` lists per route runs those routes on a second `createCloudrop`, or
  waits for a per-route option in a later release.
- **Status:** in force.
- **Visible in:** `src/plugins/content-checks.ts`.

### M10-K9: what it does not catch

- **Decision:** the guide states the limits: only the first 4 KiB is read, so a valid file of one type carrying another
  further in (a polyglot) passes as its first type; an XML type a route names may carry scripts; archives are not
  opened; there is no virus scanning; `deny` sees only what the first bytes show; text that starts like a web page (a
  Markdown file opening with `<p>`, `<div>` or `<!--`) is refused; a file never completed stays in the bucket under a
  declared type `/upload` let through.
- **Why:** a browser serves a stored file by its stored type, which this check makes agree with the content; a PNG
  that also holds HTML is displayed as an image. XML is the exception: a browser runs scripts anywhere in a document it
  renders as XML, and a namespace can be spelled with character references, so naming an XML type in `accept` is the
  app's choice to take script-capable files. Scanning whole files would cost a full read per upload and belongs to the
  quarantine and scanning work the design leaves for later.
- **If wrong:** an app that serves user files from its own origin should still send `X-Content-Type-Options: nosniff`,
  serve XML and SVG from a domain of their own or as downloads, and keep private routes private.
- **Status:** in force.
- **Visible in:** `docs/guide/plugins.md`.

### M10-K10: `MZ` and `ID3` count only with the header they open

- **Decision:** a file is a Windows or DOS program when it starts with `MZ`, is at least 28 bytes long, and either (a)
  is at least 64 bytes long and `e_lfanew` (the 32-bit little-endian value at `0x3C`) points inside the bytes read at
  `PE\0\0`, `NE`, `LE` or `LX`, or, where the read cuts the header off (past the read, or in the last three bytes read
  after a matching start), at an offset under `09 09 09 09` where four bytes still fit in the file, or (b) its MS-DOS
  header describes a program: fewer than 512 bytes on the last page (`e_cblp`, at 2) and a header of at least two
  16-byte paragraphs (`e_cparhdr`, at 8) that fits in the file's 512-byte pages (`e_cp`, at 4). `sniff` takes the file's
  size for (a); `contentChecks()` passes the size the upload token signed. A file is an ID3-tagged recording when it
  starts with `ID3`, is at least 10 bytes long, its major version is 2 to 4, its revision is under `FF`, the low four
  bits of its flags are clear, and each of the four size bytes is under `80`.
- **Why:** two or three letters are text that people write: a CSV whose first cell is `MZ` (Mozambique's country code)
  was refused as a program, and a note that starts "ID3 tags are" contradicted every text type (review finding,
  2026-11-21). The rules come from the formats' own definitions. Microsoft's PE Format ("MS-DOS Stub" and "Signature"):
  the offset at `0x3C` leads to `PE\0\0`, and `MZ` and that offset are all Windows' loader reads, so a packed or
  hand-made program with zeroed DOS fields is found by (a), also when its header lies past the first 4 KiB; `NE`
  (Microsoft's Executable-File Header Format) and `LE`/`LX` (IBM's Linear eXecutable Module Format) are the older
  headers the same offset leads to. The MS-DOS Encyclopedia, Article 4, for the `.EXE` header, whose last-page count is
  the image length modulo 512 and whose header size counts paragraphs, so (b) finds a DOS program and any program a
  linker made. ID3v2.4.0 structure §3.1, whose detection pattern is `49 44 33 yy yy xx zz zz zz zz` with `yy` under `FF`
  and `zz` under `80`; versions 2.2 to 2.4 define no flag in the low four bits. Text cannot form either header inside
  the first 4 KiB: the last-page count under 512 needs a byte `00` or `01` at offset 3, a version byte of 2 to 4 is a
  control character, and four text bytes at `0x3C` read as an offset of at least `09 09 09 09` (151 MB), which (a) never
  takes past the bytes read, whatever the file's size; no DOS stub is that long.
- **If wrong:** binary data that starts with `MZ` and happens to form either header reads as a program, as every `MZ`
  file did before; no such format is known. A file under 28 bytes is not a program DOS can load and is not detected. A
  file with an ID3 header of a future version 5 is not read as MP3 and keeps only its declared type, which `/upload`
  judged.
- **Status:** in force; `src/plugins/sniff.test.ts` holds a PE header as GNU ld and lld-link write it, a packed one, an
  NE and an LX one, one past the first 4 KiB, one ending the file there and one the read cuts off, DOS programs,
  ID3v2.2, v2.3 and v2.4 tags, and as near misses the CSV, the prose, a 3 GB log that starts with `MZ`, each DOS header
  field and each ID3 field broken alone, and both headers one byte short; `src/plugins/content-checks.test.ts` refuses a
  program whose PE header lies past 4 KiB, which needs the file's size.
- **Visible in:** `src/plugins/sniff.ts`, `src/plugins/content-checks.ts`, `docs/guide/plugins.md`.

### M10-K11: a `#!` line naming a path stays refused, and once allowed agrees with any text type

- **Decision:** a file is a script when it starts with `#!`, any spaces or tabs, and `/`. It stays refused by default,
  also on a route that takes `text/*`; `allow: ["text/x-shellscript"]` lets scripts through. An allowed script then
  agrees with every `text/` type, the shell script types (`text/x-sh`, `application/x-sh`,
  `application/x-shellscript`) and the types freedesktop.org's shared-mime-info gives Perl, Ruby and PHP files
  (`application/x-perl`, `application/x-ruby`, `application/x-php`), so a Python script sent as `text/x-python` or a
  Perl script sent as `application/x-perl` passes.
- **Why:** the design refuses scripts, and a script is the one text file a system runs as it stands once downloaded;
  a route that takes source code is the exception, and says so with `allow`. `execve(2)` defines the line as `#!`, the
  interpreter's path and an optional argument, and Linux's `binfmt_script` skips the blanks between; scripts name the
  path in full, so prose such as "#!important" is no longer taken for a script (review finding, 2026-11-21). Before,
  an allowed script sent as `text/x-python` still failed as a contradiction, which left `allow` unusable for scripts.
- **If wrong:** a `#!` line without a `/` (a relative path, or `#!python3`, the form PEP 397 documents for Windows'
  `py` launcher) is not detected and passes as its declared type, which `/upload` judged; on Windows the extension,
  not the line, decides how a file runs. Text that starts with `#!/`, such as a list of hash-bang URLs
  (`#!/products/42`), is refused as a script; the route allows `text/x-shellscript` to take it. An allowed script sent
  under an `application/` type not listed above is refused as a contradiction.
- **Status:** in force; `src/plugins/sniff.test.ts`, `src/plugins/content-checks.test.ts`.
- **Visible in:** `src/plugins/sniff-text.ts`, `docs/guide/plugins.md`.

### M10-K12: what the review before release added: APNG, one more program type, MP3's four bytes, serving advice

- **Decision:** a PNG agrees with `image/apng` as well as `image/png`. `application/x-ms-dos-executable`
  (shared-mime-info's type for `.exe`) is refused at `/upload` and agrees with a Windows program. An MPEG audio frame
  header counts only with all four of its bytes (and, since `M11-R136`, only before a second header where its frame ends). The guide's Limits tell the app to serve stored files with
  `X-Content-Type-Options: nosniff` (or from a domain of their own), say that `.bat`, `.cmd` and `.ps1` have no
  signature, that a recognised package (Word, OpenDocument, EPUB) is not `application/zip` for `deny`, and that an
  SVG whose leading comments fill the first 4 KiB reads as HTML; the errors guide names the refusal of a file sent as
  `application/octet-stream` whose content `accept` does not take.
- **Why:** `image/apng` is registered with IANA (2022-11-21, change controller W3C, for PNG Third Edition) and is what
  browsers declare for `.apng`, so an animated PNG was refused as a contradiction. A program sent under a type
  missing from the list passed `/upload` and stayed in the bucket when never completed. WHATWG MIME Sniffing §6.2.3
  reads a frame header only from four bytes. A text file with no signature, JavaScript among them, passes as the text
  type a route takes, and `nosniff` is what stops a browser loading it as a script; the `attachment` disposition
  cloudrop stores stops only a page opening it.
- **If wrong:** none; each is a narrower refusal or a sentence of the guide.
- **Status:** in force; `src/plugins/sniff.test.ts`, `src/plugins/content-checks.test.ts`,
  `src/plugins/content-checks-upload.test.ts`.
- **Visible in:** `src/plugins/sniff.ts`, `src/plugins/content-checks.ts`, `docs/guide/plugins.md`,
  `docs/guide/errors.md`.
