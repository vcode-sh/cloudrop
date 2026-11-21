# M10-K: content checks

Rulings for `cloudrop/plugins` and `contentChecks()`, designed in `docs/superpowers/specs/2026-11-21-0.4.0-design.md`.
Entries continue from 1.

### M10-K1: the type from the first 4 KiB, by each format's own signature

- **Decision:** `contentChecks()` reads bytes `0` to `min(size, 4096) - 1` of the stored file with
  `storage.getRange` and detects one of: PNG, JPEG, GIF, WebP, WAV, PDF, Ogg, FLAC, MP3 (an ID3v2 tag or an MPEG audio
  frame header), the ISO BMFF brands (AVIF, HEIC and HEIF, MP4, M4A, QuickTime, 3GPP), the EBML DocType (WebM,
  Matroska), ZIP and the packages inside it (Office Open XML by an entry under `word/`, `xl/` or `ppt/`, OpenDocument
  and EPUB by their first `mimetype` entry), Windows, Linux and macOS programs (`MZ`, ELF, Mach-O and universal
  binaries), a `#!` line, and as text after a UTF-8 or UTF-16 byte order mark and leading whitespace: HTML (WHATWG's
  tag list at the start, an XHTML root or namespace), SVG (an `svg` root element or the SVG namespace) and XML
  (`<?xml`). Each row cites its specification in `src/plugins/sniff*.ts`; the table with sources is in
  [Plugins](../guide/plugins.md#what-it-recognises). A detection carries the declared types it agrees with (aliases,
  and for ZIP and XML the `+zip` and `+xml` families).
- **Why:** these are the formats upload forms take and the ones that do harm when mislabelled. Only the start decides,
  as in a browser's own sniffing (WHATWG MIME Sniffing §7.1), so the check refuses what a browser would treat as
  HTML, not every file that mentions a tag. Three choices avoid refusing real files: an ISO BMFF file counts only when
  its major brand is known (a camera's raw file compatible with `isom` is not a video), an MPEG audio header is not
  read after a byte order mark (UTF-16LE text starting with `h` forms a valid one), and an XML document without
  `<?xml` and without an SVG or XHTML root is not XML (a browser does not sniff it as XML either). The HTML tag must end
  in whitespace, `>` or `/`, a little wider than WHATWG's space or `>`: a parser reads those the same.
- **If wrong:** a format that starts with one of these signatures by chance would be refused as a contradiction; none
  is known among the types `accept.ts` lists. `MZ` refuses any file that starts with those two letters.
- **Status:** in force. `src/plugins/sniff.test.ts` holds one vector per signature and the near misses.
- **Visible in:** `src/plugins/sniff.ts`, `src/plugins/sniff-containers.ts`, `src/plugins/sniff-text.ts`,
  `docs/guide/plugins.md`.

### M10-K2: the order of the rules, and what an unknown type does

- **Decision:** a file is refused, first match wins: (1) its detected type, then its declared type, is refused by
  default or by `deny` (M10-K3); (2) the content was detected and contradicts a declared type other than
  `application/octet-stream`; (3) the declared type is `application/octet-stream` and no type the content agrees with
  is in `accept`. Content that matches no signature passes as its declared type, which `/upload` already checked
  against `accept`.
- **Why:** the design asks for three refusals (not in `accept`, contradicting the declared type, dangerous whatever the
  declared type). A declared type that agrees with the content was accepted at `/upload`, so "not in `accept`" can only
  happen when the browser could not type the file: then there is nothing to contradict and the content's own type is
  checked. The content goes first in (1) so the message names what the file is. The declared type is checked too: a
  file sent as `text/html` is served as a page whatever its first bytes are.
- **If wrong:** a route that accepts `application/octet-stream` alone, to take files the browser cannot type, refuses
  an untyped PNG; it lists the content types it takes instead.
- **Status:** in force; `src/plugins/content-checks.test.ts`.
- **Visible in:** `src/plugins/content-checks.ts`.

### M10-K3: web pages, programs and scripts are refused by default; XML needs its type named

- **Decision:** refused whatever the route accepts: `text/html`, `application/xhtml+xml`, the program types
  (`application/vnd.microsoft.portable-executable`, `application/x-msdownload`, `application/x-msdos-program`,
  `application/x-dosexec`, `application/x-executable`, `application/x-elf`, `application/x-sharedlib`,
  `application/x-mach-binary`) and the script types (the JavaScript types, `text/x-shellscript`, `application/x-sh`,
  `application/x-shellscript`, `text/x-sh`). Every XML type (`text/xml`, `application/xml` and any `+xml`, SVG among
  them) passes only when the file was sent as an XML type that the route's `accept` lists exactly. `allow` lifts these
  refusals per type; `deny` adds to them and wins over `allow`.
- **Why:** the design names HTML, executables, scripts and SVG. The SVG rule is widened to every XML type because a
  browser renders `text/xml` and `application/rss+xml` too, and an element in the SVG or XHTML namespace runs its
  scripts there; "named exactly" means `image/*` or `*/*` let no XML through by accident.
- **If wrong:** a route that takes RSS or other XML on purpose lists the type in `accept`; one that takes HTML adds it
  to `allow` and `accept`.
- **Status:** in force.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/guide/plugins.md`.

### M10-K4: a refusal is `FILE_TYPE_NOT_ALLOWED`; no new code

- **Decision:** every refusal is `FILE_TYPE_NOT_ALLOWED` (400, not retryable) with one of two messages: "This file is
  <what it is>, which this upload does not accept. Pick another file." or "This file is <what it is>, but it was sent
  as <declared type>. Give it the right extension, or pick another file." What it is comes from the detection table
  ("a JPEG image", "a program"); the declared type is the normalized MIME type `/upload` signed. A failure to read the
  bucket throws, which the handler answers as the retryable `SERVER_ERROR` it gives any failing `afterVerify`, keeping
  the object.
- **Why:** the code already means "this file's type is not allowed here" at `/upload`, which is what the person must
  hear; an app showing it needs no new branch. `VERIFICATION_FAILED` means the stored size or type differs from the
  token, which is not this case. The client drops a non-retryable failure and asks `/upload` for a new ticket on
  `retry()`, so no client change is needed. A read failure says nothing about the file, so it must not refuse it.
- **If wrong:** an app that must tell a refusal at `/upload` from one at `/complete` reads the endpoint from where the
  error surfaced; a code of its own would be a new public code.
- **Status:** in force; `docs/guide/errors.md`.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/guide/errors.md`.

### M10-K5: `cloudrop/plugins` is built apart and imports `CloudropError` from `cloudrop`

- **Decision:** `src/plugins.ts` is a new entry, built like `cloudrop/testing` in a configuration of its own whose
  imports of `src/index.ts` become imports of `./index.js` (`tsdown.config.ts`, `apart("plugins")`). It holds only the
  plugins and the code they need (`accept-entry.ts`, split from `accept.ts` so its extension table stays out). Its
  size-limit budget counts its own file: 6 kB gzip, measured 4.44 kB. `scripts/check-package.sh` fails when
  `dist/testing.js` or `dist/plugins.js` defines `CloudropError` or does not import `./index.js`.
- **Why:** the server checks a plugin's refusal with `instanceof CloudropError` (`runAfterVerify`); a copy of the class
  would turn every refusal into a server error. Building it with the library's entries would move shared modules into
  chunks and change every entry's size (M9-T2). No other entry imports it, so a server without plugins ships none of
  it.
- **If wrong:** a plugin that needs another class from the server is imported the same way, through `src/index.ts`.
- **Status:** in force.
- **Visible in:** `src/plugins.ts`, `tsdown.config.ts`, `scripts/size-limit.config.ts`, `scripts/check-package.sh`,
  `package.json` exports.

### M10-K6: what runs where

- **Decision:** the check is an `afterVerify` hook, so it runs at `/complete` after the server verified the object (or
  completed the multipart upload) and before `onComplete`, outside any database transaction. With a store, the
  refusal path that already exists ends the row `rejected` first and deletes the object only when that change was this
  request's; the store releases the owner's reserved bytes with the row; every plugin's `onAbort` runs with
  `"rejected"`. Stateless, the object is deleted and `onAbort` runs; a failed delete answers the storage error and keeps
  the object, so a retry checks it again. An empty file is not read.
- **Why:** these are the guarantees every `afterVerify` refusal already has (M5 spec §5.5), proven for content checks
  in lease and transaction mode, single PUT and multipart (`content-checks-store.test.ts`). R2 answers a range of an
  empty object with `416 InvalidRange` and serves a range past a short object's end clamped to it (measured
  2026-11-21: 0 bytes `416`; 1, 100, 4,096 and 5,000 bytes `206` with `content-range` ending at the last byte or at
  4,095); the fake R2 does the same, and the live lane runs the plugin on 0-byte, 1-byte and 5 KiB files.
- **If wrong:** a backend that ignores `Range` and sends a whole object would make the read cost the object's size;
  the bytes are cut to 4 KiB, but the transfer is not. R2, RustFS, Wrangler and S3 honour it.
- **Status:** in force; `src/plugins/content-checks.r2.integration.test.ts` in `bun run test:live`.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/research/r2-spike-findings.md`.

### M10-K7: `afterVerify` receives the route's `accept`

- **Decision:** `AfterVerifyContext` gains `accept: readonly string[]`, the route's entries as `createCloudrop` read
  them. A public type gets a new required field, which only code that builds a context by hand (a plugin's own tests)
  must add.
- **Why:** M10-K3 needs to know whether the route names a type exactly or lets it in through a wildcard; the route's
  definition, which `extendRoute` sees, holds `accept` before it is normalized. Any plugin that checks types needs it.
- **If wrong:** a plugin that wants the rest of the route's configuration asks for it the same way.
- **Status:** in force.
- **Visible in:** `src/server/plugins.ts`, `src/server/complete-steps.ts`, `docs/guide/server.md`.

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
  further in (a polyglot) passes as its first type; archives are not opened; there is no virus scanning; text that
  starts like a web page (a Markdown file opening with `<div>`) is refused.
- **Why:** a browser serves a stored file by its stored type, which this check makes agree with the content; a PNG
  that also holds HTML is displayed as an image. Scanning whole files would cost a full read per upload and belongs to
  the quarantine and scanning work the design leaves for later.
- **If wrong:** an app that serves user files from its own origin should still send `X-Content-Type-Options: nosniff`
  and keep private routes private.
- **Status:** in force.
- **Visible in:** `docs/guide/plugins.md`.
