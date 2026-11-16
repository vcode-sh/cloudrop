# M1: Repository foundation and storage layer, implementation plan

> **Status (2026-11-16): done.** Executed 2026-11-15, closed at `ca28497`; later fixes landed with M2. The
> checkboxes below are not ticked: what was built is in git history and `docs/decisions/m1-rulings.md`. Where the
> project stands now: [`README.md`](README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bun-workspace repository with the `cloudrop` package's storage layer: our own SigV4 signer, an
S3-compatible driver with `r2()` and `s3()` presets, an R2-correct part planner, an in-process fake R2, and one storage
contract suite that runs against the fake, RustFS, Wrangler's local R2 endpoint and real R2.

**Architecture:** Pure TypeScript using only web-platform APIs (`fetch`, `crypto.subtle`, `TextEncoder`), so the same
code runs in Node 22+, Bun, Deno, Workers and browsers. Every driver call returns `Result<T>` (`{ data, error }`);
storage failures map to stable `CloudropError` codes with human messages. The fake verifies real SigV4 signatures,
so tests exercise the same failure modes as R2 (`SignatureDoesNotMatch`, `ExpiredRequest`, `InvalidPart`).

**Tech stack:** Bun 1.4.4 (workspaces, scripts), TypeScript 7.0.2, Vitest 5.1.0 (runs on Node), tsdown 0.23.7,
Biome 2.6.7, fast-check 4.10.2 and aws4fetch 1.0.20 (dev only), Docker image `rustfs/rustfs:1.0.5`, Wrangler 4.162.0.

**Spec:** [`docs/superpowers/specs/2026-11-15-cloudrop-design.md`](../specs/2026-11-15-cloudrop-design.md) (§3 package
layout, §5.1 plan, §5.3 keys, §9 file API, §11 testing, §12 real-R2 results). Evidence for R2 behaviour:
[`docs/research/r2-spike-findings.md`](../../research/r2-spike-findings.md).

## Global constraints

- Everything in English: code, comments, docs, commit messages, test names, CLI output.
- Zero runtime dependencies in `packages/cloudrop`. Dev dependencies are fine.
- No `node:` imports and no `process` access under `packages/cloudrop/src/`, except the guarded env read in
  `storage/presets.ts`. Tests and scripts may use Node APIs.
- ESM only. TypeScript `strict`, `noUncheckedIndexedAccess`, `isolatedDeclarations`: every exported function and
  constant has an explicit type.
- Public calls return `Result<T>`; they never throw for expected failures. Construction-time configuration errors
  throw `CloudropError` with code `INVALID_CONFIG`.
- Every error `message` says what happened and what to do next. Never include credentials, signed URLs or raw storage
  response bodies in messages. The storage service's own code goes into `storageCode` for logs only.
- Never print, log or commit credentials. Never log a presigned URL (it contains the access key ID).
- Live R2 tests write only under `live-test/cloudrop-<random hex>/` and delete everything they create.
- Docker containers started by tests carry the label `cloudrop.test` and are removed when the run ends, including on
  failure.
- Never clone or create worktrees in `/tmp`; on this machine use `~/projects/.worktrees/cloudrop/<slug>`.
- Git: stage exact paths only (never `git add -A` or `.`), conventional commits, never push unless asked.
- Pinned versions: `typescript@7.0.2`, `vitest@5.1.0`, `tsdown@0.23.7`, `@biomejs/biome@2.6.7`, `aws4fetch@1.0.20`,
  `fast-check@4.10.2`, `wrangler@4.162.0`, `rustfs/rustfs:1.0.5`, Bun `1.4.4`.

## File map

```
package.json                          root: workspaces, scripts
biome.json                            lint and format
AGENTS.md, CLAUDE.md                  agent rules for this repo
.github/workflows/ci.yml              CI lanes
scripts/rustfs.sh                     start/stop the RustFS container
scripts/test-rustfs.sh                RustFS contract lane with guaranteed teardown
scripts/test-wrangler.sh              Wrangler contract lane with guaranteed teardown
scripts/test-live-r2.ts               live R2 lane; loads credentials without printing them
packages/cloudrop/
  package.json, tsconfig.json, tsdown.config.ts, vitest.config.ts
  src/index.ts                        public entry
  src/errors.ts                       CloudropError, Result, ok, fail
  src/rules.ts                        StorageRules, R2_RULES, S3_RULES, size units
  src/plan.ts                         planUpload, planParts
  src/checksum.ts                     crc32c, crc32cBase64
  src/storage/xml.ts                  tiny XML reader for S3 responses
  src/storage/storage-error.ts        HTTP status + S3 code → CloudropError
  src/storage/sigv4.ts                SigV4 header signing and query presigning
  src/storage/validate.ts             key, metadata, size, expiry checks
  src/storage/driver.ts               StorageDriver interface and types
  src/storage/s3-driver.ts            createS3Driver
  src/storage/presets.ts              r2(), s3()
  src/testing/fake-r2.ts              in-process fake with R2 rules and real signature checks
  test/globals.d.ts                   process.env typing for tests
  test/contract/storage-contract.ts   shared contract suite
  test/contract/*.contract.test.ts    lanes: fake, live R2, RustFS, Wrangler
  test/wrangler/wrangler.jsonc, worker.ts   minimal Worker exposing the local R2 S3 endpoint
docs/research/test-backends.md        observed deviations per backend (created in Task 12 or 13 if any)
```

---

### Task 1: Workspace scaffold, tooling and agent rules

**Files:**
- Create: `package.json`, `biome.json`, `AGENTS.md`, `CLAUDE.md`
- Create: `packages/cloudrop/package.json`, `packages/cloudrop/tsconfig.json`, `packages/cloudrop/tsdown.config.ts`,
  `packages/cloudrop/vitest.config.ts`, `packages/cloudrop/src/index.ts`, `packages/cloudrop/test/globals.d.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: root scripts `check`, `fix`, `typecheck`, `test`, `build`; package scripts `typecheck`, `test`, `build`.

- [ ] **Step 1: Check the volume and write the root files**

Run `findmnt ~/projects` and stop if it prints nothing. Then create `package.json`:

```json
{
  "name": "cloudrop-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.4.4",
  "workspaces": ["packages/*"],
  "scripts": {
    "check": "biome check .",
    "fix": "biome check --write .",
    "typecheck": "bun run --filter cloudrop typecheck",
    "test": "bun run --filter cloudrop test",
    "build": "bun run --filter cloudrop build"
  }
}
```

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.7/schema.json",
  "files": { "includes": ["**", "!**/dist", "!**/node_modules", "!spikes/**", "!**/.wrangler", "!**/.state"] },
  "formatter": { "indentStyle": "space", "lineWidth": 120 },
  "linter": { "rules": { "recommended": true } }
}
```

Append to `.gitignore`:

```
.wrangler/
packages/cloudrop/test/wrangler/.state/
```

- [ ] **Step 2: Write the package files**

`packages/cloudrop/package.json`:

```json
{
  "name": "cloudrop",
  "version": "0.0.0",
  "description": "Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.",
  "license": "MIT",
  "type": "module",
  "sideEffects": false,
  "files": ["dist"],
  "engines": { "node": ">=22" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`packages/cloudrop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedDeclarations": true,
    "declaration": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

`packages/cloudrop/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  sourcemap: true,
});
```

`packages/cloudrop/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
```

`packages/cloudrop/src/index.ts` (replaced in Task 9):

```ts
export {};
```

`packages/cloudrop/test/globals.d.ts` (tests read env without pulling Node types into `src`):

```ts
declare const process: { env: Record<string, string | undefined> };
```

- [ ] **Step 3: Install pinned dev dependencies**

```bash
cd ~/projects/cloudrop
bun add -d --exact @biomejs/biome@2.6.7
cd packages/cloudrop
bun add -d --exact typescript@7.0.2 vitest@5.1.0 tsdown@0.23.7 aws4fetch@1.0.20 fast-check@4.10.2
```

Expected: `bun.lock` created at the repository root; no `dependencies` field in `packages/cloudrop/package.json`.

- [ ] **Step 4: Write `AGENTS.md` and `CLAUDE.md`**

`AGENTS.md`:

```markdown
# cloudrop: rules for coding agents

cloudrop is an MIT TypeScript library for direct-to-bucket uploads to Cloudflare R2 and S3-compatible storage.
Design: `docs/superpowers/specs/2026-11-15-cloudrop-design.md`. Plans: `docs/superpowers/plans/`.
Real-R2 evidence: `docs/research/r2-spike-findings.md`. Work strictly from Cloudflare's R2 documentation and that
evidence; when they disagree, the measured behaviour wins and the docs page is cited.

## Rules

- Write everything in English.
- `packages/cloudrop` has zero runtime dependencies and uses only web-platform APIs in `src/`.
- Public calls return `{ data, error }`. Error messages say what happened and what to do next; they never contain
  credentials, presigned URLs or raw storage responses.
- Never print, log or commit credentials, and never log a presigned URL.
- Live R2 tests write only under `live-test/cloudrop-<random>/` and delete what they create.
- Docker containers from tests carry the label `cloudrop.test` and are removed at the end of the run.
- Git: stage exact paths, conventional commits, never push unless asked. Never `git stash`, `reset`, `clean` or
  `checkout --`.
- Never clone or create worktrees in `/tmp`.

## Gates

- `bun run check` and `bun run typecheck` for every change; `bun run test` when behaviour changes.
- `scripts/test-rustfs.sh`, `scripts/test-wrangler.sh` and `bun run test:live` for storage-layer changes.
```

`CLAUDE.md`:

```markdown
# cloudrop

`AGENTS.md` is the single source of project rules.

@AGENTS.md
```

- [ ] **Step 5: Verify the toolchain**

```bash
cd ~/projects/cloudrop && bun run check && bun run typecheck && bun run build
ls packages/cloudrop/dist
```

Expected: all three succeed; `dist` contains `index.js` and `index.d.ts`. If tsdown names the output `index.mjs` /
`index.d.mts`, change the two paths in the `exports` map to match and re-run `bun run build`. If `typecheck` later
reports that `process` is already declared (a dev dependency pulled in Node's types), delete `test/globals.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock biome.json .gitignore AGENTS.md CLAUDE.md \
  packages/cloudrop/package.json packages/cloudrop/tsconfig.json packages/cloudrop/tsdown.config.ts \
  packages/cloudrop/vitest.config.ts packages/cloudrop/src/index.ts packages/cloudrop/test/globals.d.ts
git commit -m "chore: scaffold bun workspace and cloudrop package tooling"
```

---

### Task 2: Errors, XML reader and storage error mapping

**Files:**
- Create: `packages/cloudrop/src/errors.ts`, `packages/cloudrop/src/storage/xml.ts`,
  `packages/cloudrop/src/storage/storage-error.ts`
- Test: `packages/cloudrop/src/storage/storage-error.test.ts`, `packages/cloudrop/src/storage/xml.test.ts`

**Interfaces:**
- Produces:
  - `type CloudropErrorCode = "INVALID_INPUT" | "INVALID_CONFIG" | "STORAGE_UNREACHABLE" | "STORAGE_DENIED" | "STORAGE_ERROR" | "RATE_LIMITED" | "NOT_FOUND" | "ALREADY_EXISTS" | "NO_SUCH_UPLOAD" | "INVALID_PART" | "CHECKSUM_MISMATCH"`
  - `class CloudropError extends Error { code; retryable: boolean; status: number | undefined; storageCode: string | undefined }`,
    constructor `(code, message, options?: { retryable?, status?, storageCode?, cause? })`
  - `type Result<T> = { data: T; error: null } | { data: null; error: CloudropError }`
  - `ok<T>(data: T): Result<T>`, `fail(error: CloudropError): { data: null; error: CloudropError }`
  - `xmlBlocks(xml, tag): string[]`, `xmlText(xml, tag): string | undefined`, `stripQuotes(value): string`,
    `escapeXml(value): string`
  - `storageError(status: number, body: string): CloudropError`

- [ ] **Step 1: Write the failing tests**

`packages/cloudrop/src/storage/xml.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeXml, stripQuotes, xmlBlocks, xmlText } from "./xml.ts";

describe("xml reader", () => {
  const listParts = `<?xml version="1.0"?><ListPartsResult><PartNumberMarker>0</PartNumberMarker>
    <Part><PartNumber>1</PartNumber><ETag>&quot;abc&quot;</ETag><Size>5242880</Size></Part>
    <Part><PartNumber>2</PartNumber><ETag>"def"</ETag><Size>10</Size></Part></ListPartsResult>`;

  it("returns every block of a tag without matching longer tag names", () => {
    expect(xmlBlocks(listParts, "Part")).toHaveLength(2);
  });

  it("decodes entities in text and strips ETag quotes", () => {
    const first = xmlBlocks(listParts, "Part")[0] ?? "";
    expect(stripQuotes(xmlText(first, "ETag") ?? "")).toBe("abc");
    expect(xmlText("<Key>a&amp;b&#x2F;c</Key>", "Key")).toBe("a&b/c");
  });

  it("escapes text for XML", () => {
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
});
```

`packages/cloudrop/src/storage/storage-error.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { storageError } from "./storage-error.ts";

const body = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>raw text</Message></Error>`;

describe("storageError", () => {
  it.each([
    [404, "NoSuchUpload", "NO_SUCH_UPLOAD", false],
    [404, "NoSuchKey", "NOT_FOUND", false],
    [404, "", "NOT_FOUND", false],
    [412, "PreconditionFailed", "ALREADY_EXISTS", false],
    [400, "InvalidPart", "INVALID_PART", false],
    [400, "EntityTooSmall", "INVALID_PART", false],
    [400, "BadDigest", "CHECKSUM_MISMATCH", false],
    [403, "SignatureDoesNotMatch", "STORAGE_DENIED", false],
    [429, "ServiceUnavailable", "RATE_LIMITED", true],
    [503, "SlowDown", "RATE_LIMITED", true],
    [500, "InternalError", "STORAGE_ERROR", true],
    [400, "InvalidArgument", "STORAGE_ERROR", false],
  ] as const)("maps HTTP %i %s to %s", (status, code, expected, retryable) => {
    const error = storageError(status, code ? body(code) : "");
    expect(error.code).toBe(expected);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
    expect(error.storageCode).toBe(code || undefined);
  });

  it("never copies the storage service's message into the error message", () => {
    expect(storageError(400, body("InvalidArgument")).message).not.toContain("raw text");
  });
});
```

The 429 row uses `ServiceUnavailable` on purpose: real R2 returned that code with HTTP 429 (spike Q9), so mapping must
key on the status.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/cloudrop && bunx vitest run src/storage`
Expected: FAIL, modules `./xml.ts` and `./storage-error.ts` not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/errors.ts`:

```ts
export type CloudropErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "STORAGE_UNREACHABLE"
  | "STORAGE_DENIED"
  | "STORAGE_ERROR"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NO_SUCH_UPLOAD"
  | "INVALID_PART"
  | "CHECKSUM_MISMATCH";

export interface CloudropErrorOptions {
  retryable?: boolean;
  status?: number;
  storageCode?: string;
  cause?: unknown;
}

export class CloudropError extends Error {
  readonly code: CloudropErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** The storage service's own error code, for logs. Never shown to end users. */
  readonly storageCode: string | undefined;

  constructor(code: CloudropErrorCode, message: string, options: CloudropErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CloudropError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.storageCode = options.storageCode;
  }
}

export type Result<T> = { data: T; error: null } | { data: null; error: CloudropError };

export function ok<T>(data: T): Result<T> {
  return { data, error: null };
}

export function fail(error: CloudropError): { data: null; error: CloudropError } {
  return { data: null, error };
}
```

`packages/cloudrop/src/storage/xml.ts`:

```ts
// S3 responses are small, flat XML documents. A tag-based reader covers every response cloudrop parses and keeps the
// package free of an XML dependency.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Inner XML of every `<tag>…</tag>` element, in document order. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? "");
}

/** Decoded text of the first `<tag>` element, or undefined when absent. */
export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : decodeXml(block.trim());
}

export function stripQuotes(value: string): string {
  return value.replaceAll('"', "");
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[char]};`);
}
```

`packages/cloudrop/src/storage/storage-error.ts`:

```ts
import { CloudropError } from "../errors.ts";
import { xmlText } from "./xml.ts";

const INVALID_PART_CODES = new Set(["InvalidPart", "InvalidPartOrder", "EntityTooSmall"]);

/**
 * Turns a failed S3 response into a CloudropError. Mapping keys on the HTTP status first: real R2 answered a
 * same-key write burst with HTTP 429 and S3 code "ServiceUnavailable" (docs/research/r2-spike-findings.md, Q9).
 */
export function storageError(status: number, body: string): CloudropError {
  const storageCode = xmlText(body, "Code") || undefined;
  const options = { status, storageCode };
  if (status === 404 && storageCode === "NoSuchUpload") {
    return new CloudropError("NO_SUCH_UPLOAD", "The multipart upload no longer exists. Start a new upload.", options);
  }
  if (status === 404) return new CloudropError("NOT_FOUND", "The object does not exist.", options);
  if (status === 412) return new CloudropError("ALREADY_EXISTS", "An object with this key already exists.", options);
  if (storageCode && INVALID_PART_CODES.has(storageCode)) {
    return new CloudropError(
      "INVALID_PART",
      "One or more parts are missing or have the wrong size. Upload them again, then complete the upload.",
      options,
    );
  }
  if (storageCode === "BadDigest") {
    return new CloudropError("CHECKSUM_MISMATCH", "The uploaded bytes do not match their checksum. Upload them again.", options);
  }
  if (status === 403) {
    return new CloudropError(
      "STORAGE_DENIED",
      "The storage service refused the request. Check the access key, its permissions and the bucket name.",
      options,
    );
  }
  if (status === 429 || status === 503) {
    return new CloudropError("RATE_LIMITED", "The storage service is throttling requests. Retry after a short delay.", {
      ...options,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new CloudropError("STORAGE_ERROR", "The storage service failed. Retry the request.", { ...options, retryable: true });
  }
  return new CloudropError(
    "STORAGE_ERROR",
    `The storage service rejected the request (HTTP ${status}${storageCode ? `, ${storageCode}` : ""}).`,
    options,
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd packages/cloudrop && bunx vitest run src/storage && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS; check and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/errors.ts packages/cloudrop/src/storage/xml.ts packages/cloudrop/src/storage/xml.test.ts \
  packages/cloudrop/src/storage/storage-error.ts packages/cloudrop/src/storage/storage-error.test.ts
git commit -m "feat(storage): add result type, XML reader and storage error mapping"
```

---

### Task 3: SigV4 signer on WebCrypto

**Files:**
- Create: `packages/cloudrop/src/storage/sigv4.ts`
- Test: `packages/cloudrop/src/storage/sigv4.test.ts`

**Interfaces:**
- Produces:
  - `interface Credentials { accessKeyId: string; secretAccessKey: string }`
  - `interface SigningInput { method: string; url: URL; headers?: Record<string, string>; credentials: Credentials; region: string; date: Date }`
  - `presignUrl(input: SigningInput & { expiresIn: number }): Promise<URL>` (query auth, `UNSIGNED-PAYLOAD`, always
    signs `host` plus every header in `input.headers`)
  - `signRequest(input: SigningInput & { payloadHash: string }): Promise<Record<string, string>>` (returns the input
    headers plus `x-amz-content-sha256`, `x-amz-date`, `authorization`)
  - `sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string>`, `toHex(bytes): string`
  - `encodeRfc3986(value): string`, `encodeKeyPath(key): string`, `EMPTY_SHA256`, `UNSIGNED_PAYLOAD`

- [ ] **Step 1: Write the failing tests**

The two expected signatures are AWS's published examples. If a vector fails, compare against the AWS pages cited in
the test; never edit the expected value.

`packages/cloudrop/src/storage/sigv4.test.ts`:

```ts
import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { EMPTY_SHA256, encodeKeyPath, presignUrl, signRequest } from "./sigv4.ts";

const AWS_EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");
const EXAMPLE_URL = "https://examplebucket.s3.amazonaws.com/test.txt";

describe("presignUrl", () => {
  it("matches the AWS S3 query-string signing example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await presignUrl({
      method: "GET",
      url: new URL(EXAMPLE_URL),
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      expiresIn: 86_400,
    });
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("agrees with aws4fetch on signed headers, encoded keys and existing query parameters", async () => {
    const credentials = { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };
    const base = "https://account.r2.cloudflarestorage.com/bucket/a%20b/%C3%A9.png?partNumber=3&uploadId=abc%2Fdef";
    const headers = { "content-length": "5242880", "content-type": "image/png", "if-none-match": "*" };
    const ours = await presignUrl({
      method: "PUT",
      url: new URL(base),
      headers,
      credentials,
      region: "auto",
      date: new Date("2026-11-15T12:00:00Z"),
      expiresIn: 900,
    });
    const client = new AwsClient({ ...credentials, service: "s3", region: "auto" });
    const theirs = await client.sign(`${base}&X-Amz-Expires=900`, {
      method: "PUT",
      headers,
      aws: { signQuery: true, allHeaders: true, datetime: "20261115T120000Z" },
    });
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(new URL(theirs.url).searchParams.get("X-Amz-Signature"));
  });
});

describe("signRequest", () => {
  it("matches the AWS S3 header signing GET Object example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html ("Example: GET Object")
    const headers = await signRequest({
      method: "GET",
      url: new URL(EXAMPLE_URL),
      headers: { range: "bytes=0-9" },
      credentials: AWS_EXAMPLE,
      region: "us-east-1",
      date: EXAMPLE_DATE,
      payloadHash: EMPTY_SHA256,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("encodeKeyPath", () => {
  it("encodes every segment with RFC 3986 rules and keeps slashes", () => {
    expect(encodeKeyPath("a b/é+(1)!.png")).toBe("a%20b/%C3%A9%2B%281%29%21.png");
  });
});
```

If the aws4fetch comparison fails while both AWS vectors pass, print both canonical requests (aws4fetch exposes
`new AwsV4Signer(...).canonicalString()`) and fix the difference in `sigv4.ts`, not in the test.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/cloudrop && bunx vitest run src/storage/sigv4.test.ts`
Expected: FAIL, `./sigv4.ts` not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/storage/sigv4.ts`:

```ts
// AWS Signature Version 4 for S3, on WebCrypto, so it runs in browsers, Workers, Deno, Bun and Node.
// Presigned URLs sign exactly the headers the client will send: R2 enforces signed content-length, content-type and
// checksum headers, and ignores checksum values passed as query parameters (docs/research/r2-spike-findings.md).

const encoder = new TextEncoder();

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigningInput {
  method: string;
  url: URL;
  /** Headers to sign. `host` is always signed and taken from `url`. */
  headers?: Record<string, string>;
  credentials: Credentials;
  region: string;
  date: Date;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encodes an object key for a URL path: each segment RFC 3986-encoded, slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalQuery(params: URLSearchParams): string {
  return Array.from(params, ([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) => {
      if (aName !== bName) return aName < bName ? -1 : 1;
      if (aValue === bValue) return 0;
      return aValue < bValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalHeaders(url: URL, headers: Record<string, string>): { canonical: string; signedHeaders: string } {
  const all: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(all).sort();
  return { canonical: names.map((name) => `${name}:${all[name]}\n`).join(""), signedHeaders: names.join(";") };
}

async function sign(input: SigningInput, amzDate: string, scope: string, canonicalRequest: string): Promise<string> {
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), amzDate.slice(0, 8));
  for (const part of [input.region, "s3", "aws4_request"]) key = await hmac(key, part);
  return toHex(await hmac(key, stringToSign));
}

export async function presignUrl(input: SigningInput & { expiresIn: number }): Promise<URL> {
  const amzDate = toAmzDate(input.date);
  const scope = `${amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const { canonical, signedHeaders } = canonicalHeaders(input.url, input.headers ?? {});
  const url = new URL(input.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(input.expiresIn));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
  const query = canonicalQuery(url.searchParams);
  const request = [input.method, url.pathname, query, canonical, signedHeaders, UNSIGNED_PAYLOAD].join("\n");
  url.search = `${query}&X-Amz-Signature=${await sign(input, amzDate, scope, request)}`;
  return url;
}

export async function signRequest(input: SigningInput & { payloadHash: string }): Promise<Record<string, string>> {
  const amzDate = toAmzDate(input.date);
  const scope = `${amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const headers = { ...input.headers, "x-amz-content-sha256": input.payloadHash, "x-amz-date": amzDate };
  const { canonical, signedHeaders } = canonicalHeaders(input.url, headers);
  const request = [
    input.method,
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    canonical,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const signature = await sign(input, amzDate, scope, request);
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd packages/cloudrop && bunx vitest run src/storage/sigv4.test.ts && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS (4 tests); check and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/storage/sigv4.ts packages/cloudrop/src/storage/sigv4.test.ts
git commit -m "feat(storage): add SigV4 header signing and query presigning on WebCrypto"
```

---

### Task 4: CRC32C

**Files:**
- Create: `packages/cloudrop/src/checksum.ts`
- Test: `packages/cloudrop/src/checksum.test.ts`

**Interfaces:**
- Produces: `crc32c(bytes: Uint8Array, previous?: number): number` (pass the previous result to continue a stream),
  `crc32cBase64(bytes: Uint8Array): string` (the `x-amz-checksum-crc32c` header value: base64 of the big-endian value)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { crc32c, crc32cBase64 } from "./checksum.ts";

const text = (value: string) => new TextEncoder().encode(value);

describe("crc32c", () => {
  it("matches the published check value for 123456789", () => {
    expect(crc32c(text("123456789"))).toBe(0xe3069283);
    expect(crc32cBase64(text("123456789"))).toBe("4waSgw==");
  });

  it("continues across chunks", () => {
    expect(crc32c(text("6789"), crc32c(text("12345")))).toBe(0xe3069283);
  });

  it("is zero for empty input", () => {
    expect(crc32cBase64(new Uint8Array())).toBe("AAAAAA==");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/cloudrop && bunx vitest run src/checksum.test.ts`
Expected: FAIL, `./checksum.ts` not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/checksum.ts`:

```ts
// CRC32C (Castagnoli), the per-part checksum R2 validates when it is a signed header (spike Q5). A table-driven
// implementation is enough here; spec §11.1 gates any WebAssembly kernel behind a benchmark.

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (const byte of bytes) crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return ~crc >>> 0;
}

export function crc32cBase64(bytes: Uint8Array): string {
  const value = crc32c(bytes);
  return btoa(String.fromCharCode(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff));
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd packages/cloudrop && bunx vitest run src/checksum.test.ts && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/checksum.ts packages/cloudrop/src/checksum.test.ts
git commit -m "feat: add CRC32C checksum"
```

---

### Task 5: Storage rules and the part planner

**Files:**
- Create: `packages/cloudrop/src/rules.ts`, `packages/cloudrop/src/plan.ts`
- Test: `packages/cloudrop/src/plan.test.ts`

**Interfaces:**
- Produces:
  - `interface StorageRules { provider: "r2" | "s3"; minPartSize; maxPartSize; maxParts; maxSinglePutSize; maxObjectSize; maxPresignSeconds; equalParts: boolean }` (all sizes in bytes)
  - `MiB`, `GiB`, `TiB: number`; `R2_RULES`, `S3_RULES: StorageRules`
  - `type MultipartPlan = { kind: "multipart"; size; partSize; partCount; lastPartSize }`
  - `type UploadPlan = { kind: "single"; size: number } | MultipartPlan`
  - `DEFAULT_MULTIPART_THRESHOLD: number` (64 MiB)
  - `planParts(size: number, rules: StorageRules): MultipartPlan`
  - `planUpload(size: number, rules: StorageRules, options?: { multipartThreshold?: number }): UploadPlan`
  - Both throw `RangeError` for a negative, fractional or oversized `size`: callers validate first; reaching it is a
    programming error.

R2 limits come from `docs/research/r2-platform-and-test-backends.md` §C (single PUT and part size 5 GiB minus 5 MiB;
object 5 TiB minus 5 GiB; 10,000 parts; presign at most 604,800 s, confirmed by spike Q7).

- [ ] **Step 1: Write the failing test**

`packages/cloudrop/src/plan.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planUpload } from "./plan.ts";
import { GiB, MiB, R2_RULES } from "./rules.ts";

describe("planUpload", () => {
  it("uses one PUT up to the multipart threshold", () => {
    expect(planUpload(64 * MiB, R2_RULES)).toEqual({ kind: "single", size: 64 * MiB });
    expect(planUpload(0, R2_RULES)).toEqual({ kind: "single", size: 0 });
  });

  it("splits larger files into 8 MiB parts with a smaller last part", () => {
    expect(planUpload(64 * MiB + 1, R2_RULES)).toEqual({
      kind: "multipart",
      size: 64 * MiB + 1,
      partSize: 8 * MiB,
      partCount: 9,
      lastPartSize: 1,
    });
  });

  it("doubles the part size until the file fits in 10,000 parts", () => {
    expect(planUpload(100 * GiB, R2_RULES)).toMatchObject({ partSize: 16 * MiB, partCount: 6400 });
  });

  it("honours a custom threshold", () => {
    expect(planUpload(10 * MiB, R2_RULES, { multipartThreshold: 0 })).toMatchObject({ partCount: 2, lastPartSize: 2 * MiB });
  });

  it("rejects sizes the storage cannot hold", () => {
    expect(() => planUpload(R2_RULES.maxObjectSize + 1, R2_RULES)).toThrow(RangeError);
    expect(() => planUpload(-1, R2_RULES)).toThrow(RangeError);
  });

  it("always produces a plan R2 accepts", () => {
    const anySize = fc.bigInt({ min: 0n, max: BigInt(R2_RULES.maxObjectSize) }).map(Number);
    fc.assert(
      fc.property(anySize, (size) => {
        const plan = planUpload(size, R2_RULES);
        if (plan.kind === "single") return size <= 64 * MiB;
        return (
          plan.partSize >= R2_RULES.minPartSize &&
          plan.partSize <= R2_RULES.maxPartSize &&
          plan.partCount <= R2_RULES.maxParts &&
          plan.lastPartSize > 0 &&
          plan.lastPartSize <= plan.partSize &&
          (plan.partCount - 1) * plan.partSize + plan.lastPartSize === size
        );
      }),
    );
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/cloudrop && bunx vitest run src/plan.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/rules.ts`:

```ts
export const MiB: number = 1024 * 1024;
export const GiB: number = 1024 * MiB;
export const TiB: number = 1024 * GiB;

/** Limits of a storage backend, in bytes and seconds. */
export interface StorageRules {
  provider: "r2" | "s3";
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxSinglePutSize: number;
  maxObjectSize: number;
  maxPresignSeconds: number;
  /** R2 requires every part except the last to have the same size. */
  equalParts: boolean;
}

export const R2_RULES: StorageRules = {
  provider: "r2",
  minPartSize: 5 * MiB,
  maxPartSize: 5 * GiB - 5 * MiB,
  maxParts: 10_000,
  maxSinglePutSize: 5 * GiB - 5 * MiB,
  maxObjectSize: 5 * TiB - 5 * GiB,
  maxPresignSeconds: 604_800,
  equalParts: true,
};

export const S3_RULES: StorageRules = {
  provider: "s3",
  minPartSize: 5 * MiB,
  maxPartSize: 5 * GiB,
  maxParts: 10_000,
  maxSinglePutSize: 5 * GiB,
  maxObjectSize: 5 * TiB,
  maxPresignSeconds: 604_800,
  equalParts: false,
};
```

`packages/cloudrop/src/plan.ts`:

```ts
import { MiB, type StorageRules } from "./rules.ts";

export type MultipartPlan = { kind: "multipart"; size: number; partSize: number; partCount: number; lastPartSize: number };
export type UploadPlan = { kind: "single"; size: number } | MultipartPlan;

export const DEFAULT_MULTIPART_THRESHOLD: number = 64 * MiB;
const FIRST_PART_SIZE = 8 * MiB;

function assertStorable(size: number, rules: StorageRules): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`File size must be a whole number of bytes, got ${size}.`);
  if (size > rules.maxObjectSize) {
    throw new RangeError(`File size ${size} exceeds the storage limit of ${rules.maxObjectSize} bytes.`);
  }
}

/**
 * Equal parts of 8, 16, 32… MiB: the smallest size that keeps the count within the part limit. Every part except the
 * last has exactly `partSize` bytes, which satisfies R2's equal-part rule by construction (spec §5.1).
 */
export function planParts(size: number, rules: StorageRules): MultipartPlan {
  assertStorable(size, rules);
  let partSize = Math.max(FIRST_PART_SIZE, rules.minPartSize);
  while (Math.ceil(size / partSize) > rules.maxParts) partSize *= 2;
  partSize = Math.min(partSize, rules.maxPartSize);
  const partCount = Math.max(1, Math.ceil(size / partSize));
  return { kind: "multipart", size, partSize, partCount, lastPartSize: size - (partCount - 1) * partSize };
}

export function planUpload(size: number, rules: StorageRules, options: { multipartThreshold?: number } = {}): UploadPlan {
  assertStorable(size, rules);
  const threshold = Math.min(options.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD, rules.maxSinglePutSize);
  if (size === 0 || size <= threshold) return { kind: "single", size };
  return planParts(size, rules);
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd packages/cloudrop && bunx vitest run src/plan.test.ts && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/rules.ts packages/cloudrop/src/plan.ts packages/cloudrop/src/plan.test.ts
git commit -m "feat: add storage rules and the R2-correct part planner"
```

---

### Task 6: Driver types and input validation

**Files:**
- Create: `packages/cloudrop/src/storage/driver.ts`, `packages/cloudrop/src/storage/validate.ts`
- Test: `packages/cloudrop/src/storage/validate.test.ts`

**Interfaces:**
- Produces (`driver.ts`):

```ts
import type { CloudropError, Result } from "../errors.ts";
import type { StorageRules } from "../rules.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Stored with the object. Metadata names use lowercase letters, digits and hyphens. */
export interface ObjectOptions {
  type?: string;
  disposition?: string;
  metadata?: Record<string, string>;
}

export interface WriteOptions extends ObjectOptions {
  /** Create-only: the write fails with ALREADY_EXISTS when the key exists. */
  ifNoneMatch?: boolean;
  /** Base64 CRC32C of the body; the storage rejects mismatching bytes. */
  checksumCrc32c?: string;
}

/**
 * A presigned request. Send `headers` exactly as given. The body length must equal the signed size; clients do not
 * set Content-Length themselves (browsers forbid it), the HTTP stack derives it from the body.
 */
export interface PresignedRequest {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectInfo {
  key: string;
  size: number;
  type?: string;
  disposition?: string;
  etag: string;
  uploadedAt: Date;
  metadata: Record<string, string>;
  checksumCrc64nvme?: string;
}

export interface PartInfo {
  partNumber: number;
  size: number;
  etag: string;
  checksumCrc32c?: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
  uploadedAt: Date;
}

export interface StorageDriver {
  readonly rules: StorageRules;
  readonly publicUrl?: string;
  presignPut(key: string, options: WriteOptions & { size: number; expiresIn: number }): Promise<Result<PresignedRequest>>;
  createMultipart(key: string, options: ObjectOptions): Promise<Result<{ uploadId: string }>>;
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { size: number; expiresIn: number; checksumCrc32c?: string },
  ): Promise<Result<PresignedRequest>>;
  listParts(key: string, uploadId: string): Promise<Result<PartInfo[]>>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
    options?: { ifNoneMatch?: boolean },
  ): Promise<Result<{ etag: string }>>;
  /** Idempotent: aborting an unknown or finished upload succeeds. */
  abortMultipart(key: string, uploadId: string): Promise<Result<void>>;
  /** `null` only when the object does not exist; every other failure is an error. */
  head(key: string): Promise<Result<ObjectInfo | null>>;
  /** Inclusive byte range. */
  getRange(key: string, start: number, end: number): Promise<Result<Uint8Array>>;
  put(key: string, body: Uint8Array<ArrayBuffer> | string | Blob, options?: WriteOptions): Promise<Result<{ etag: string }>>;
  /** Server-side copy that keeps type, disposition and metadata; multipart copy above the single-PUT limit. */
  copy(from: string, to: string): Promise<Result<{ etag: string }>>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<Result<void>>;
  /** Per-key results; order is not guaranteed. */
  deleteMany(keys: readonly string[]): Promise<Result<{ deleted: string[]; failed: { key: string; error: CloudropError }[] }>>;
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<Result<{ items: ListedObject[]; nextCursor: string | null }>>;
}
```

- Produces (`validate.ts`): `invalidInput(message): CloudropError`, and problem finders returning a human message or
  `null`: `keyProblem(key)`, `metadataProblem(metadata?)`, `sizeProblem(size, max)`, `expiryProblem(seconds, max)`,
  `partNumberProblem(partNumber, maxParts)`, `rangeProblem(start, end)`.

- [ ] **Step 1: Write the failing test**

`packages/cloudrop/src/storage/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expiryProblem, keyProblem, metadataProblem, partNumberProblem, rangeProblem, sizeProblem } from "./validate.ts";

describe("keyProblem", () => {
  it("accepts ordinary keys, including Unicode", () => {
    expect(keyProblem("users/42/avatars/01JD3K.png")).toBeNull();
    expect(keyProblem("zdjęcia/łódź.jpg")).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["/leading", "slash"],
    ["a/../b", "segment"],
    ["a/./b", "segment"],
    ["..", "segment"],
    ["tab\there", "control"],
    ["x".repeat(1025), "1024"],
  ])("rejects %j", (key, fragment) => {
    expect(keyProblem(key)).toContain(fragment);
  });
});

describe("metadataProblem", () => {
  it("accepts lowercase names and printable ASCII values", () => {
    expect(metadataProblem({ "cloudrop-id": "01JD3K" })).toBeNull();
  });

  it("rejects uppercase names, non-ASCII values and oversized metadata", () => {
    expect(metadataProblem({ Owner: "x" })).toContain("lowercase");
    expect(metadataProblem({ owner: "Łukasz" })).toContain("ASCII");
    expect(metadataProblem({ big: "x".repeat(2049) })).toContain("2 KiB");
  });
});

describe("numeric checks", () => {
  it("bounds sizes, expiry, part numbers and ranges", () => {
    expect(sizeProblem(10, 10)).toBeNull();
    expect(sizeProblem(11, 10)).toContain("10");
    expect(sizeProblem(1.5, 10)).not.toBeNull();
    expect(expiryProblem(604_800, 604_800)).toBeNull();
    expect(expiryProblem(0, 604_800)).toContain("1 and 604800");
    expect(partNumberProblem(10_000, 10_000)).toBeNull();
    expect(partNumberProblem(0, 10_000)).not.toBeNull();
    expect(rangeProblem(0, 4095)).toBeNull();
    expect(rangeProblem(5, 4)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/cloudrop && bunx vitest run src/storage/validate.test.ts`
Expected: FAIL, `./validate.ts` not found.

- [ ] **Step 3: Implement**

Create `packages/cloudrop/src/storage/driver.ts` with exactly the interface block above. Then
`packages/cloudrop/src/storage/validate.ts`:

```ts
import { CloudropError } from "../errors.ts";

const encoder = new TextEncoder();
const MAX_KEY_BYTES = 1024;
const MAX_METADATA_BYTES = 2048;

export function invalidInput(message: string): CloudropError {
  return new CloudropError("INVALID_INPUT", message);
}

/**
 * Keys reach the URL path, where `.` and `..` segments would be normalised away and break the signature (an earlier
 * implementation signed `/m/id/` for a file named `..`). Reject them instead of rewriting them.
 */
export function keyProblem(key: string): string | null {
  if (key.length === 0) return "The object key is empty. Pass a non-empty key.";
  if (encoder.encode(key).length > MAX_KEY_BYTES) return "The object key is longer than 1024 bytes. Use a shorter key.";
  if (key.startsWith("/")) return "The object key starts with a slash. Remove the leading slash.";
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "The object key contains control characters. Remove them.";
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    return "The object key contains a '.' or '..' segment. Use plain path segments.";
  }
  return null;
}

export function metadataProblem(metadata: Record<string, string> | undefined): string | null {
  let bytes = 0;
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!/^[a-z0-9-]+$/.test(name)) return `Metadata name "${name}" may contain only lowercase letters, digits and hyphens.`;
    if (!/^[\x20-\x7e]*$/.test(value)) return `Metadata value for "${name}" must be printable ASCII. Encode other text first.`;
    bytes += name.length + value.length;
  }
  return bytes > MAX_METADATA_BYTES ? "Metadata exceeds 2 KiB. Store large values in your database instead." : null;
}

export function sizeProblem(size: number, max: number): string | null {
  if (Number.isSafeInteger(size) && size >= 0 && size <= max) return null;
  return `Size must be a whole number of bytes between 0 and ${max}.`;
}

export function expiryProblem(seconds: number, max: number): string | null {
  if (Number.isInteger(seconds) && seconds >= 1 && seconds <= max) return null;
  return `Expiry must be a whole number of seconds between 1 and ${max}.`;
}

export function partNumberProblem(partNumber: number, maxParts: number): string | null {
  if (Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= maxParts) return null;
  return `Part number must be between 1 and ${maxParts}.`;
}

export function rangeProblem(start: number, end: number): string | null {
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start) return null;
  return "The byte range must satisfy 0 <= start <= end.";
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd packages/cloudrop && bunx vitest run src/storage/validate.test.ts && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/storage/driver.ts packages/cloudrop/src/storage/validate.ts packages/cloudrop/src/storage/validate.test.ts
git commit -m "feat(storage): define the storage driver interface and input validation"
```

---

### Task 7: In-process fake R2

**Files:**
- Create: `packages/cloudrop/src/testing/fake-r2.ts`
- Test: `packages/cloudrop/src/testing/fake-r2.test.ts`

**Interfaces:**
- Consumes: `presignUrl`, `signRequest`, `sha256Hex`, `Credentials` (Task 3); `crc32cBase64` (Task 4); `MiB`
  (Task 5); `xmlBlocks`, `xmlText`, `escapeXml` (Task 2); `FetchLike` (Task 6).
- Produces: `createFakeR2(options: { bucket: string; credentials: Credentials; now?: () => Date }): FakeR2` where
  `interface FakeR2 { fetch: FetchLike; objectKeys(): string[]; pendingUploads(): number }`.

The fake behaves like real R2 as measured in the spike: it recomputes SigV4 signatures (so a mismatched signed
`content-length`, `content-type` or `if-none-match` gives `403 SignatureDoesNotMatch`), rejects expired URLs with
`403 ExpiredRequest`, validates signed CRC32C headers (`400 BadDigest`), enforces equal parts only at completion
(`400 InvalidPart` / `EntityTooSmall`) and keeps the upload alive after such a failure, discards the upload on a
`412` at completion, answers `404 NoSuchUpload` to a retried completion, and replaces a multipart object's ETag on
copy. It speaks path-style URLs `/<bucket>/<key>`.

- [ ] **Step 1: Write the failing test**

`packages/cloudrop/src/testing/fake-r2.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { presignUrl } from "../storage/sigv4.ts";
import { createFakeR2 } from "./fake-r2.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
const objectUrl = (key: string) => new URL(`https://account.r2.cloudflarestorage.com/test/${key}`);
const text = (value: string) => new TextEncoder().encode(value);

async function presignedPut(key: string, headers: Record<string, string>, options: { secondsAgo?: number; secret?: string } = {}) {
  return presignUrl({
    method: "PUT",
    url: objectUrl(key),
    headers,
    credentials: { ...credentials, secretAccessKey: options.secret ?? credentials.secretAccessKey },
    region: "auto",
    date: new Date(Date.now() - (options.secondsAgo ?? 0) * 1000),
    expiresIn: 60,
  });
}

describe("fake R2 signature checks", () => {
  it("accepts a body that matches the signed length and rejects other lengths", async () => {
    const fake = createFakeR2({ bucket: "test", credentials });
    const url = await presignedPut("a.txt", { "content-length": "5" });
    expect((await fake.fetch(url, { method: "PUT", body: text("hello") })).status).toBe(200);
    const wrong = await fake.fetch(url, { method: "PUT", body: text("hello!") });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain("SignatureDoesNotMatch");
  });

  it("rejects an omitted signed header", async () => {
    const fake = createFakeR2({ bucket: "test", credentials });
    const url = await presignedPut("b.txt", { "content-length": "2", "if-none-match": "*" });
    expect((await fake.fetch(url, { method: "PUT", body: text("hi") })).status).toBe(403);
    expect((await fake.fetch(url, { method: "PUT", body: text("hi"), headers: { "if-none-match": "*" } })).status).toBe(200);
  });

  it("rejects expired URLs and URLs signed with another secret", async () => {
    const fake = createFakeR2({ bucket: "test", credentials });
    const expired = await fake.fetch(await presignedPut("c.txt", { "content-length": "2" }, { secondsAgo: 120 }), {
      method: "PUT",
      body: text("hi"),
    });
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain("ExpiredRequest");
    const forged = await presignedPut("c.txt", { "content-length": "2" }, { secret: "another-secret" });
    expect((await fake.fetch(forged, { method: "PUT", body: text("hi") })).status).toBe(403);
  });

  it("rejects unsigned requests", async () => {
    const fake = createFakeR2({ bucket: "test", credentials });
    expect((await fake.fetch(objectUrl("d.txt"), { method: "PUT", body: text("hi") })).status).toBe(403);
  });
});
```

Multipart, copy, list and checksum behaviour of the fake is exercised through the driver in Task 8 and the contract
suite in Task 10, which also run against real R2.

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/cloudrop && bunx vitest run src/testing`
Expected: FAIL, `./fake-r2.ts` not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/testing/fake-r2.ts`:

```ts
// In-process fake of the R2 S3 API with the behaviour measured on real R2 (docs/research/r2-spike-findings.md).
// It recomputes SigV4 signatures, so tests see the same failures as real R2. It is a test double, not a server.

import { crc32cBase64 } from "../checksum.ts";
import { MiB } from "../rules.ts";
import type { FetchLike } from "../storage/driver.ts";
import { type Credentials, presignUrl, sha256Hex, signRequest } from "../storage/sigv4.ts";
import { escapeXml, xmlBlocks, xmlText } from "../storage/xml.ts";

export interface FakeR2Options {
  bucket: string;
  credentials: Credentials;
  now?: () => Date;
}

export interface FakeR2 {
  fetch: FetchLike;
  objectKeys(): string[];
  pendingUploads(): number;
}

type Bytes = Uint8Array<ArrayBuffer>;

interface StoredHeaders {
  type: string | undefined;
  disposition: string | undefined;
  metadata: Record<string, string>;
}

interface StoredObject {
  body: Bytes;
  headers: StoredHeaders;
  etag: string;
  uploadedAt: Date;
  partCount?: number;
}

interface StoredPart {
  body: Bytes;
  etag: string;
  checksumCrc32c: string | undefined;
}

interface PendingUpload {
  key: string;
  headers: StoredHeaders;
  parts: Map<number, StoredPart>;
}

const XML_HEADERS = { "content-type": "application/xml" };
const META_PREFIX = "x-amz-meta-";

function xmlResponse(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: XML_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return xmlResponse(`<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, status);
}

const noSuchUpload = (): Response => errorResponse(404, "NoSuchUpload", "The specified multipart upload does not exist.");

function parseAmzDate(value: string): Date {
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
}

async function etagOf(body: Bytes): Promise<string> {
  return (await sha256Hex(body)).slice(0, 32);
}

function concat(chunks: Bytes[]): Bytes {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function readHeaders(headers: Headers): StoredHeaders {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(META_PREFIX)) metadata[name.slice(META_PREFIX.length)] = value;
  });
  return {
    type: headers.get("content-type") ?? undefined,
    disposition: headers.get("content-disposition") ?? undefined,
    metadata,
  };
}

function checksumMismatch(headers: Headers, body: Bytes): Response | null {
  const expected = headers.get("x-amz-checksum-crc32c");
  if (expected === null || expected === crc32cBase64(body)) return null;
  return errorResponse(400, "BadDigest", "The CRC32C you specified did not match the calculated checksum.");
}

export function createFakeR2(options: FakeR2Options): FakeR2 {
  const now = options.now ?? (() => new Date());
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, PendingUpload>();
  let uploadCounter = 0;

  async function verifyPresigned(request: Request, url: URL, body: Bytes): Promise<Response | null> {
    const query = url.searchParams;
    const amzDate = query.get("X-Amz-Date") ?? "";
    const expires = Number(query.get("X-Amz-Expires"));
    if (!Number.isInteger(expires) || expires < 1 || expires > 604_800) {
      return errorResponse(400, "AuthorizationQueryParametersError", "X-Amz-Expires must be between 1 and 604800 seconds.");
    }
    if (now().getTime() > parseAmzDate(amzDate).getTime() + expires * 1000) {
      return errorResponse(403, "ExpiredRequest", "Request has expired.");
    }
    const headers: Record<string, string> = {};
    for (const name of (query.get("X-Amz-SignedHeaders") ?? "").split(";")) {
      if (name === "host") continue;
      const value = name === "content-length" ? String(body.length) : request.headers.get(name);
      if (value === null) return errorResponse(403, "SignatureDoesNotMatch", `Signed header ${name} is missing.`);
      headers[name] = value;
    }
    const unsigned = new URL(url);
    for (const name of Array.from(unsigned.searchParams.keys())) {
      if (name.startsWith("X-Amz-")) unsigned.searchParams.delete(name);
    }
    const region = (query.get("X-Amz-Credential") ?? "").split("/")[2] ?? "";
    const expected = await presignUrl({
      method: request.method,
      url: unsigned,
      headers,
      credentials: options.credentials,
      region,
      date: parseAmzDate(amzDate),
      expiresIn: expires,
    });
    if (expected.searchParams.get("X-Amz-Signature") === query.get("X-Amz-Signature")) return null;
    return errorResponse(403, "SignatureDoesNotMatch", "The request signature does not match.");
  }

  async function verifyHeaderSigned(request: Request, url: URL, body: Bytes): Promise<Response | null> {
    const authorization = request.headers.get("authorization");
    if (!authorization) return errorResponse(403, "AccessDenied", "The request is not signed.");
    const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
    if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== (await sha256Hex(body))) {
      return errorResponse(400, "XAmzContentSHA256Mismatch", "The payload hash does not match the body.");
    }
    const headers: Record<string, string> = {};
    for (const name of /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? []) {
      if (name === "host" || name === "x-amz-date" || name === "x-amz-content-sha256") continue;
      const value = request.headers.get(name);
      if (value === null) return errorResponse(403, "SignatureDoesNotMatch", `Signed header ${name} is missing.`);
      headers[name] = value;
    }
    const expected = await signRequest({
      method: request.method,
      url,
      headers,
      credentials: options.credentials,
      region: /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(authorization)?.[1] ?? "",
      date: parseAmzDate(request.headers.get("x-amz-date") ?? ""),
      payloadHash,
    });
    if (expected.authorization === authorization) return null;
    return errorResponse(403, "SignatureDoesNotMatch", "The request signature does not match.");
  }

  async function putObject(key: string, headers: Headers, body: Bytes): Promise<Response> {
    const badChecksum = checksumMismatch(headers, body);
    if (badChecksum) return badChecksum;
    if (headers.get("if-none-match") === "*" && objects.has(key)) {
      return errorResponse(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold.");
    }
    const etag = await etagOf(body);
    objects.set(key, { body, headers: readHeaders(headers), etag, uploadedAt: now() });
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
  }

  function getObject(key: string, method: string, headers: Headers): Response {
    const object = objects.get(key);
    if (!object) return method === "HEAD" ? new Response(null, { status: 404 }) : errorResponse(404, "NoSuchKey", "The specified key does not exist.");
    const responseHeaders = new Headers({
      etag: `"${object.etag}"`,
      "last-modified": object.uploadedAt.toUTCString(),
      "content-length": String(object.body.length),
    });
    if (object.headers.type) responseHeaders.set("content-type", object.headers.type);
    if (object.headers.disposition) responseHeaders.set("content-disposition", object.headers.disposition);
    for (const [name, value] of Object.entries(object.headers.metadata)) responseHeaders.set(`${META_PREFIX}${name}`, value);
    if (object.partCount) responseHeaders.set("x-amz-mp-parts-count", String(object.partCount));
    if (method === "HEAD") return new Response(null, { status: 200, headers: responseHeaders });
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
    if (!range) return new Response(object.body, { status: 200, headers: responseHeaders });
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), object.body.length - 1);
    const slice = object.body.slice(start, end + 1);
    responseHeaders.set("content-range", `bytes ${start}-${end}/${object.body.length}`);
    responseHeaders.set("content-length", String(slice.length));
    return new Response(slice, { status: 206, headers: responseHeaders });
  }

  function createUpload(key: string, headers: Headers): Response {
    uploadCounter += 1;
    const uploadId = `fake-upload-${uploadCounter}`;
    uploads.set(uploadId, { key, headers: readHeaders(headers), parts: new Map() });
    return xmlResponse(
      `<InitiateMultipartUploadResult><Bucket>${escapeXml(options.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
    );
  }

  function findUpload(key: string, query: URLSearchParams): PendingUpload | undefined {
    const upload = uploads.get(query.get("uploadId") ?? "");
    return upload && upload.key === key ? upload : undefined;
  }

  async function uploadPart(key: string, query: URLSearchParams, headers: Headers, body: Bytes): Promise<Response> {
    const upload = findUpload(key, query);
    if (!upload) return noSuchUpload();
    const badChecksum = checksumMismatch(headers, body);
    if (badChecksum) return badChecksum;
    const partNumber = Number(query.get("partNumber"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      return errorResponse(400, "InvalidArgument", "Part number must be an integer between 1 and 10000.");
    }
    const etag = await etagOf(body);
    upload.parts.set(partNumber, { body, etag, checksumCrc32c: headers.get("x-amz-checksum-crc32c") ?? undefined });
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
  }

  async function complete(key: string, query: URLSearchParams, headers: Headers, body: Bytes): Promise<Response> {
    const uploadId = query.get("uploadId") ?? "";
    const upload = findUpload(key, query);
    if (!upload) return noSuchUpload();
    const requested = xmlBlocks(new TextDecoder().decode(body), "Part").map((block) => ({
      partNumber: Number(xmlText(block, "PartNumber")),
      etag: (xmlText(block, "ETag") ?? "").replaceAll('"', ""),
    }));
    if (requested.length === 0) return errorResponse(400, "MalformedXML", "The request lists no parts.");
    const parts: StoredPart[] = [];
    let previousNumber = 0;
    for (const item of requested) {
      if (item.partNumber <= previousNumber) return errorResponse(400, "InvalidPartOrder", "Parts must be listed in ascending order.");
      previousNumber = item.partNumber;
      const part = upload.parts.get(item.partNumber);
      if (!part || part.etag !== item.etag) {
        return errorResponse(400, "InvalidPart", `Part ${item.partNumber} was not found or its ETag does not match.`);
      }
      parts.push(part);
    }
    const firstSize = parts[0]?.body.length ?? 0;
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      if (!isLast && part.body.length < 5 * MiB) {
        return errorResponse(400, "EntityTooSmall", "Every part except the last must be at least 5 MiB.");
      }
      if (!isLast && part.body.length !== firstSize) {
        return errorResponse(400, "InvalidPart", "All parts except the last must have the same size.");
      }
      if (isLast && parts.length > 1 && part.body.length > firstSize) {
        return errorResponse(400, "InvalidPart", "The last part must not be larger than the other parts.");
      }
    }
    if (headers.get("if-none-match") === "*" && objects.has(key)) {
      uploads.delete(uploadId);
      return errorResponse(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold.");
    }
    const etag = `${await etagOf(new TextEncoder().encode(parts.map((part) => part.etag).join("")))}-${parts.length}`;
    objects.set(key, { body: concat(parts.map((part) => part.body)), headers: upload.headers, etag, uploadedAt: now(), partCount: parts.length });
    uploads.delete(uploadId);
    return xmlResponse(
      `<CompleteMultipartUploadResult><Bucket>${escapeXml(options.bucket)}</Bucket><Key>${escapeXml(key)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`,
    );
  }

  function listParts(key: string, query: URLSearchParams): Response {
    const upload = findUpload(key, query);
    if (!upload) return noSuchUpload();
    const max = Math.min(Number(query.get("max-parts") ?? 1000), 1000);
    const marker = Number(query.get("part-number-marker") ?? 0);
    const remaining = Array.from(upload.parts).filter(([number]) => number > marker).sort(([a], [b]) => a - b);
    const page = remaining.slice(0, max);
    const truncated = remaining.length > max;
    const parts = page
      .map(([number, part]) => {
        const checksum = part.checksumCrc32c ? `<ChecksumCRC32C>${part.checksumCrc32c}</ChecksumCRC32C>` : "";
        return `<Part><PartNumber>${number}</PartNumber><ETag>"${part.etag}"</ETag><Size>${part.body.length}</Size>${checksum}</Part>`;
      })
      .join("");
    const next = truncated ? `<NextPartNumberMarker>${page.at(-1)?.[0] ?? marker}</NextPartNumberMarker>` : "";
    return xmlResponse(`<ListPartsResult><IsTruncated>${truncated}</IsTruncated>${next}${parts}</ListPartsResult>`);
  }

  async function copy(key: string, query: URLSearchParams, headers: Headers): Promise<Response> {
    const [, sourceBucket = "", ...sourceSegments] = (headers.get("x-amz-copy-source") ?? "").split("/");
    const source =
      decodeURIComponent(sourceBucket) === options.bucket
        ? objects.get(sourceSegments.map(decodeURIComponent).join("/"))
        : undefined;
    if (!source) return errorResponse(404, "NoSuchKey", "The copy source does not exist.");
    if (query.has("uploadId")) {
      const upload = findUpload(key, query);
      if (!upload) return noSuchUpload();
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("x-amz-copy-source-range") ?? "");
      const body = range ? source.body.slice(Number(range[1]), Number(range[2]) + 1) : source.body;
      const etag = await etagOf(body);
      upload.parts.set(Number(query.get("partNumber")), { body, etag, checksumCrc32c: undefined });
      return xmlResponse(`<CopyPartResult><ETag>"${etag}"</ETag></CopyPartResult>`);
    }
    // Real R2 replaces a multipart object's ETag with a plain one on copy (spike Q14).
    const etag = await etagOf(source.body);
    objects.set(key, { body: source.body, headers: source.headers, etag, uploadedAt: now() });
    return xmlResponse(`<CopyObjectResult><ETag>"${etag}"</ETag></CopyObjectResult>`);
  }

  function listObjects(query: URLSearchParams): Response {
    const prefix = query.get("prefix") ?? "";
    const after = query.get("continuation-token") ?? "";
    const max = Math.min(Number(query.get("max-keys") ?? 1000), 1000);
    const matching = Array.from(objects)
      .filter(([key]) => key.startsWith(prefix) && key > after)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const page = matching.slice(0, max);
    const truncated = matching.length > max;
    const contents = page
      .map(
        ([key, object]) =>
          `<Contents><Key>${escapeXml(key)}</Key><Size>${object.body.length}</Size><ETag>"${object.etag}"</ETag><LastModified>${object.uploadedAt.toISOString()}</LastModified></Contents>`,
      )
      .join("");
    const next = truncated ? `<NextContinuationToken>${escapeXml(page.at(-1)?.[0] ?? "")}</NextContinuationToken>` : "";
    return xmlResponse(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, bucketSegment = "", ...keySegments] = url.pathname.split("/");
    if (decodeURIComponent(bucketSegment) !== options.bucket) {
      return errorResponse(404, "NoSuchBucket", "The specified bucket does not exist.");
    }
    const key = keySegments.map(decodeURIComponent).join("/");
    const body: Bytes = new Uint8Array(await request.arrayBuffer());
    const denied = url.searchParams.has("X-Amz-Signature")
      ? await verifyPresigned(request, url, body)
      : await verifyHeaderSigned(request, url, body);
    if (denied) return denied;

    const query = url.searchParams;
    const { method, headers } = request;
    if (method === "GET" && key === "" && query.get("list-type") === "2") return listObjects(query);
    if (method === "POST" && query.has("uploads")) return createUpload(key, headers);
    if (method === "PUT" && headers.has("x-amz-copy-source")) return copy(key, query, headers);
    if (method === "PUT" && query.has("uploadId")) return uploadPart(key, query, headers, body);
    if (method === "POST" && query.has("uploadId")) return complete(key, query, headers, body);
    if (method === "GET" && query.has("uploadId")) return listParts(key, query);
    if (method === "DELETE" && query.has("uploadId")) {
      return uploads.delete(query.get("uploadId") ?? "") ? new Response(null, { status: 204 }) : noSuchUpload();
    }
    if (method === "PUT") return putObject(key, headers, body);
    if (method === "GET" || method === "HEAD") return getObject(key, method, headers);
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return errorResponse(501, "NotImplemented", `${method} is not implemented by the fake.`);
  }

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    objectKeys: () => Array.from(objects.keys()).sort(),
    pendingUploads: () => uploads.size,
  };
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd packages/cloudrop && bunx vitest run src/testing && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/testing/fake-r2.ts packages/cloudrop/src/testing/fake-r2.test.ts
git commit -m "test: add an in-process fake R2 that verifies signatures and R2 part rules"
```

---

### Task 8: S3-compatible driver

**Files:**
- Create: `packages/cloudrop/src/storage/s3-driver.ts`
- Test: `packages/cloudrop/src/storage/s3-driver.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces:

```ts
export interface S3DriverConfig {
  /** Origin plus optional path prefix, no trailing slash: "https://<account>.r2.cloudflarestorage.com". */
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials;
  rules: StorageRules;
  publicUrl?: string;
  fetch?: FetchLike;
  /** Clock for signing; tests use it to produce expired URLs. */
  now?: () => Date;
}
export function createS3Driver(config: S3DriverConfig): StorageDriver;
```

Design notes the implementer must keep:
- Path-style URLs: `<endpoint>/<bucket>/<encoded key>`.
- Every request is header-signed with the SHA-256 of its body; presigned URLs use `UNSIGNED-PAYLOAD`.
- `CompleteMultipartUpload` and `CopyObject` can answer HTTP 200 with an `<Error>` body; treat that as a failure.
- `head` sends `x-amz-checksum-mode: ENABLED` so the stored CRC64NVME is returned. If the live lane (Task 11) shows R2
  rejecting that header, remove it and note it in `docs/research/test-backends.md`.
- `deleteMany` issues concurrent single `DeleteObject` calls (16 at a time) instead of `DeleteObjects`: deletes are
  free on R2, results are naturally per key, and `DeleteObjects` needs a `Content-MD5`, which WebCrypto cannot compute.

- [ ] **Step 1: Write the failing test**

`packages/cloudrop/src/storage/s3-driver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MiB, R2_RULES } from "../rules.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import type { FetchLike } from "./driver.ts";
import { createS3Driver } from "./s3-driver.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
const endpoint = "https://account.r2.cloudflarestorage.com";

function setup(rules = R2_RULES) {
  const fake = createFakeR2({ bucket: "test", credentials });
  const driver = createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules, fetch: fake.fetch });
  return { fake, driver };
}

function bytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) out[index] = (index * 31 + seed) & 0xff;
  return out;
}

const stubbed = (respond: () => Promise<Response>): FetchLike => () => respond();

describe("createS3Driver", () => {
  it("round-trips a Unicode key with type, disposition and metadata", async () => {
    const { driver } = setup();
    const key = "zdjęcia/łódź (1).txt";
    expect((await driver.put(key, "hello", { type: "text/plain", disposition: "inline", metadata: { "cloudrop-id": "f1" } })).error).toBeNull();
    expect((await driver.head(key)).data).toMatchObject({ key, size: 5, type: "text/plain", disposition: "inline", metadata: { "cloudrop-id": "f1" } });
  });

  it("uploads through presigned part URLs and completes", async () => {
    const { fake, driver } = setup();
    const created = await driver.createMultipart("big.bin", { type: "application/octet-stream" });
    if (created.error) throw created.error;
    const sizes = [5 * MiB, 2 * MiB];
    for (const [index, size] of sizes.entries()) {
      const signed = await driver.presignPart("big.bin", created.data.uploadId, index + 1, { size, expiresIn: 60 });
      if (signed.error) throw signed.error;
      expect((await fake.fetch(signed.data.url, { method: "PUT", headers: signed.data.headers, body: bytes(size) })).status).toBe(200);
    }
    const parts = await driver.listParts("big.bin", created.data.uploadId);
    if (parts.error) throw parts.error;
    expect(parts.data.map((part) => part.size)).toEqual(sizes);
    expect((await driver.completeMultipart("big.bin", created.data.uploadId, parts.data)).error).toBeNull();
    expect((await driver.head("big.bin")).data?.size).toBe(7 * MiB);
    expect(fake.pendingUploads()).toBe(0);
  });

  it("copies objects above the single-PUT limit in parts and keeps their headers", async () => {
    const { fake, driver } = setup();
    await driver.put("source.bin", bytes(12 * MiB), { type: "application/x-test", metadata: { "cloudrop-id": "s1" } });
    // Same bucket, lower single-PUT limit, so a 12 MiB copy takes the multipart path without a 5 GiB fixture.
    const small = createS3Driver({
      endpoint,
      region: "auto",
      bucket: "test",
      credentials,
      rules: { ...R2_RULES, maxSinglePutSize: 6 * MiB },
      fetch: fake.fetch,
    });
    expect((await small.copy("source.bin", "copy.bin")).error).toBeNull();
    expect((await driver.head("copy.bin")).data).toMatchObject({
      size: 12 * MiB,
      type: "application/x-test",
      metadata: { "cloudrop-id": "s1" },
    });
    const range = await driver.getRange("copy.bin", 8 * MiB, 8 * MiB + 3);
    expect(range.data).toEqual(bytes(12 * MiB).slice(8 * MiB, 8 * MiB + 4));
  });

  it("rejects invalid keys before any request", async () => {
    const driver = createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch: stubbed(() => Promise.reject(new Error("must not be called"))) });
    expect((await driver.head("a/../b")).error?.code).toBe("INVALID_INPUT");
    expect((await driver.presignPut("x", { size: R2_RULES.maxSinglePutSize + 1, expiresIn: 60 })).error?.code).toBe("INVALID_INPUT");
  });

  it("reports an unreachable endpoint as retryable, never as a missing object", async () => {
    const driver = createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch: stubbed(() => Promise.reject(new TypeError("fetch failed"))) });
    const result = await driver.head("a.txt");
    expect(result.error?.code).toBe("STORAGE_UNREACHABLE");
    expect(result.error?.retryable).toBe(true);
  });

  it("maps throttling to RATE_LIMITED", async () => {
    const throttled = stubbed(async () => new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 429 }));
    const driver = createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch: throttled });
    expect((await driver.put("a.txt", "x")).error?.code).toBe("RATE_LIMITED");
  });

  it("treats 200 responses with an Error body as failures", async () => {
    const hidden = stubbed(async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }));
    const driver = createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch: hidden });
    expect((await driver.completeMultipart("a", "u", [{ partNumber: 1, etag: "e" }])).error?.code).toBe("STORAGE_ERROR");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/cloudrop && bunx vitest run src/storage/s3-driver.test.ts`
Expected: FAIL, `./s3-driver.ts` not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/storage/s3-driver.ts`:

```ts
import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { planParts } from "../plan.ts";
import type { StorageRules } from "../rules.ts";
import type {
  CompletedPart,
  FetchLike,
  ObjectInfo,
  ObjectOptions,
  PartInfo,
  PresignedRequest,
  StorageDriver,
  WriteOptions,
} from "./driver.ts";
import { type Credentials, EMPTY_SHA256, encodeKeyPath, encodeRfc3986, presignUrl, sha256Hex, signRequest } from "./sigv4.ts";
import { storageError } from "./storage-error.ts";
import {
  expiryProblem,
  invalidInput,
  keyProblem,
  metadataProblem,
  partNumberProblem,
  rangeProblem,
  sizeProblem,
} from "./validate.ts";
import { stripQuotes, xmlBlocks, xmlText } from "./xml.ts";

export interface S3DriverConfig {
  /** Origin plus optional path prefix, no trailing slash: "https://<account>.r2.cloudflarestorage.com". */
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials;
  rules: StorageRules;
  publicUrl?: string;
  fetch?: FetchLike;
  /** Clock for signing; tests use it to produce expired URLs. */
  now?: () => Date;
}

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const META_PREFIX = "x-amz-meta-";
const DELETE_CONCURRENCY = 16;

function objectHeaders(options: ObjectOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.type) headers["content-type"] = options.type;
  if (options.disposition) headers["content-disposition"] = options.disposition;
  for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`${META_PREFIX}${name}`] = value;
  return headers;
}

function writeHeaders(options: WriteOptions): Record<string, string> {
  const headers = objectHeaders(options);
  if (options.ifNoneMatch) headers["if-none-match"] = "*";
  if (options.checksumCrc32c) headers["x-amz-checksum-crc32c"] = options.checksumCrc32c;
  return headers;
}

function readObjectInfo(key: string, headers: Headers): ObjectInfo {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(META_PREFIX)) metadata[name.slice(META_PREFIX.length)] = value;
  });
  return {
    key,
    size: Number(headers.get("content-length") ?? "0"),
    type: headers.get("content-type") ?? undefined,
    disposition: headers.get("content-disposition") ?? undefined,
    etag: stripQuotes(headers.get("etag") ?? ""),
    uploadedAt: new Date(headers.get("last-modified") ?? 0),
    metadata,
    checksumCrc64nvme: headers.get("x-amz-checksum-crc64nvme") ?? undefined,
  };
}

async function forEachConcurrently<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function createS3Driver(config: S3DriverConfig): StorageDriver {
  const http: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = config.now ?? (() => new Date());
  const rules = config.rules;
  const bucketUrl = `${config.endpoint.replace(/\/+$/, "")}/${encodeRfc3986(config.bucket)}`;

  function objectUrl(key: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${bucketUrl}/${encodeKeyPath(key)}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async function send(method: string, url: URL, headers: Record<string, string> = {}, body?: Bytes): Promise<Result<Response>> {
    const signed = await signRequest({
      method,
      url,
      headers,
      credentials: config.credentials,
      region: config.region,
      date: now(),
      payloadHash: body ? await sha256Hex(body) : EMPTY_SHA256,
    });
    let response: Response;
    try {
      response = await http(url, { method, headers: signed, body });
    } catch (cause) {
      return fail(
        new CloudropError(
          "STORAGE_UNREACHABLE",
          "Could not reach the storage service. Check the endpoint and the network connection, then retry.",
          { retryable: true, cause },
        ),
      );
    }
    if (!response.ok) return fail(storageError(response.status, await response.text()));
    return ok(response);
  }

  /** CompleteMultipartUpload and CopyObject can answer HTTP 200 with an <Error> body. */
  async function sendForXml(method: string, url: URL, headers: Record<string, string> = {}, body?: Bytes): Promise<Result<string>> {
    const result = await send(method, url, headers, body);
    if (result.error) return result;
    const text = await result.data.text();
    if (text.includes("<Error>")) return fail(storageError(500, text));
    return ok(text);
  }

  async function presign(url: URL, headers: Record<string, string>, size: number, expiresIn: number): Promise<PresignedRequest> {
    const date = now();
    const signed = await presignUrl({
      method: "PUT",
      url,
      headers: { ...headers, "content-length": String(size) },
      credentials: config.credentials,
      region: config.region,
      date,
      expiresIn,
    });
    return { method: "PUT", url: signed.toString(), headers, expiresAt: new Date(date.getTime() + expiresIn * 1000) };
  }

  async function copyInParts(source: ObjectInfo, copySource: string, to: string): Promise<Result<{ etag: string }>> {
    const plan = planParts(source.size, rules);
    const created = await driver.createMultipart(to, source);
    if (created.error) return created;
    const { uploadId } = created.data;
    const parts: CompletedPart[] = [];
    for (let partNumber = 1; partNumber <= plan.partCount; partNumber++) {
      const start = (partNumber - 1) * plan.partSize;
      const end = Math.min(start + plan.partSize, source.size) - 1;
      const result = await sendForXml("PUT", objectUrl(to, { partNumber: String(partNumber), uploadId }), {
        "x-amz-copy-source": copySource,
        "x-amz-copy-source-range": `bytes=${start}-${end}`,
      });
      if (result.error) {
        await driver.abortMultipart(to, uploadId);
        return result;
      }
      parts.push({ partNumber, etag: stripQuotes(xmlText(result.data, "ETag") ?? "") });
    }
    const completed = await driver.completeMultipart(to, uploadId, parts);
    if (completed.error) await driver.abortMultipart(to, uploadId);
    return completed;
  }

  const driver: StorageDriver = {
    rules,
    publicUrl: config.publicUrl,

    async presignPut(key, options) {
      const problem =
        keyProblem(key) ??
        metadataProblem(options.metadata) ??
        sizeProblem(options.size, rules.maxSinglePutSize) ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds);
      if (problem) return fail(invalidInput(problem));
      return ok(await presign(objectUrl(key), writeHeaders(options), options.size, options.expiresIn));
    },

    async createMultipart(key, options) {
      const problem = keyProblem(key) ?? metadataProblem(options.metadata);
      if (problem) return fail(invalidInput(problem));
      const result = await sendForXml("POST", objectUrl(key, { uploads: "" }), objectHeaders(options));
      if (result.error) return result;
      const uploadId = xmlText(result.data, "UploadId");
      if (!uploadId) {
        return fail(new CloudropError("STORAGE_ERROR", "The storage service did not return an upload ID. Retry the upload.", { retryable: true }));
      }
      return ok({ uploadId });
    },

    async presignPart(key, uploadId, partNumber, options) {
      const problem =
        keyProblem(key) ??
        partNumberProblem(partNumber, rules.maxParts) ??
        sizeProblem(options.size, rules.maxPartSize) ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds);
      if (problem) return fail(invalidInput(problem));
      const headers: Record<string, string> = options.checksumCrc32c ? { "x-amz-checksum-crc32c": options.checksumCrc32c } : {};
      const url = objectUrl(key, { partNumber: String(partNumber), uploadId });
      return ok(await presign(url, headers, options.size, options.expiresIn));
    },

    async listParts(key, uploadId) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const parts: PartInfo[] = [];
      let marker = "0";
      let truncated = true;
      while (truncated) {
        const result = await sendForXml("GET", objectUrl(key, { uploadId, "max-parts": "1000", "part-number-marker": marker }));
        if (result.error) return result;
        for (const block of xmlBlocks(result.data, "Part")) {
          parts.push({
            partNumber: Number(xmlText(block, "PartNumber")),
            size: Number(xmlText(block, "Size")),
            etag: stripQuotes(xmlText(block, "ETag") ?? ""),
            checksumCrc32c: xmlText(block, "ChecksumCRC32C"),
          });
        }
        truncated = xmlText(result.data, "IsTruncated") === "true";
        marker = xmlText(result.data, "NextPartNumberMarker") ?? "";
        if (truncated && !marker) {
          return fail(new CloudropError("STORAGE_ERROR", "The storage service returned an incomplete part list. Retry the request.", { retryable: true }));
        }
      }
      return ok(parts);
    },

    async completeMultipart(key, uploadId, parts, options = {}) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const xml = sorted.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag}"</ETag></Part>`).join("");
      const body = encoder.encode(`<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`);
      const result = await sendForXml("POST", objectUrl(key, { uploadId }), options.ifNoneMatch ? { "if-none-match": "*" } : {}, body);
      if (result.error) return result;
      return ok({ etag: stripQuotes(xmlText(result.data, "ETag") ?? "") });
    },

    async abortMultipart(key, uploadId) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send("DELETE", objectUrl(key, { uploadId }));
      if (result.error && result.error.code !== "NO_SUCH_UPLOAD") return result;
      return ok(undefined);
    },

    async head(key) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send("HEAD", objectUrl(key), { "x-amz-checksum-mode": "ENABLED" });
      if (result.error) return result.error.code === "NOT_FOUND" ? ok(null) : result;
      return ok(readObjectInfo(key, result.data.headers));
    },

    async getRange(key, start, end) {
      const problem = keyProblem(key) ?? rangeProblem(start, end);
      if (problem) return fail(invalidInput(problem));
      const result = await send("GET", objectUrl(key), { range: `bytes=${start}-${end}` });
      if (result.error) return result;
      return ok(new Uint8Array(await result.data.arrayBuffer()));
    },

    async put(key, body, options = {}) {
      const bytes: Bytes =
        typeof body === "string" ? encoder.encode(body) : body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
      const problem = keyProblem(key) ?? metadataProblem(options.metadata) ?? sizeProblem(bytes.length, rules.maxSinglePutSize);
      if (problem) return fail(invalidInput(problem));
      const result = await send("PUT", objectUrl(key), writeHeaders(options), bytes);
      if (result.error) return result;
      return ok({ etag: stripQuotes(result.data.headers.get("etag") ?? "") });
    },

    async copy(from, to) {
      const problem = keyProblem(from) ?? keyProblem(to);
      if (problem) return fail(invalidInput(problem));
      const source = await driver.head(from);
      if (source.error) return source;
      if (!source.data) return fail(new CloudropError("NOT_FOUND", "The object to copy does not exist. Check the source key."));
      const copySource = `/${encodeRfc3986(config.bucket)}/${encodeKeyPath(from)}`;
      if (source.data.size > rules.maxSinglePutSize) return copyInParts(source.data, copySource, to);
      const result = await sendForXml("PUT", objectUrl(to), { "x-amz-copy-source": copySource });
      if (result.error) return result;
      return ok({ etag: stripQuotes(xmlText(result.data, "ETag") ?? "") });
    },

    async delete(key) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send("DELETE", objectUrl(key));
      if (result.error && result.error.code !== "NOT_FOUND") return result;
      return ok(undefined);
    },

    async deleteMany(keys) {
      const deleted: string[] = [];
      const failed: { key: string; error: CloudropError }[] = [];
      await forEachConcurrently(keys, DELETE_CONCURRENCY, async (key) => {
        const result = await driver.delete(key);
        if (result.error) failed.push({ key, error: result.error });
        else deleted.push(key);
      });
      return ok({ deleted, failed });
    },

    async list(prefix, options = {}) {
      const url = new URL(bucketUrl);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", String(Math.min(options.limit ?? 1000, 1000)));
      if (options.cursor) url.searchParams.set("continuation-token", options.cursor);
      const result = await sendForXml("GET", url);
      if (result.error) return result;
      const items = xmlBlocks(result.data, "Contents").map((block) => ({
        key: xmlText(block, "Key") ?? "",
        size: Number(xmlText(block, "Size")),
        etag: stripQuotes(xmlText(block, "ETag") ?? ""),
        uploadedAt: new Date(xmlText(block, "LastModified") ?? 0),
      }));
      const truncated = xmlText(result.data, "IsTruncated") === "true";
      return ok({ items, nextCursor: truncated ? (xmlText(result.data, "NextContinuationToken") ?? null) : null });
    },
  };

  return driver;
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd packages/cloudrop && bunx vitest run src && cd ../.. && bun run fix && bun run check && bun run typecheck`
Expected: PASS for every test under `src`.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/storage/s3-driver.ts packages/cloudrop/src/storage/s3-driver.test.ts
git commit -m "feat(storage): add the S3-compatible storage driver"
```

---

### Task 9: `r2()` and `s3()` presets and the public entry

**Files:**
- Create: `packages/cloudrop/src/storage/presets.ts`
- Modify: `packages/cloudrop/src/index.ts`
- Test: `packages/cloudrop/src/storage/presets.test.ts`

**Interfaces:**
- Produces:

```ts
export interface R2Options {
  bucket: string;
  accountId?: string;        // default env CLOUDROP_R2_ACCOUNT_ID
  accessKeyId?: string;      // default env CLOUDROP_R2_ACCESS_KEY_ID
  secretAccessKey?: string;  // default env CLOUDROP_R2_SECRET_ACCESS_KEY
  jurisdiction?: "eu" | "fedramp";
  publicUrl?: string;
  fetch?: FetchLike;
}
export function r2(options: R2Options): StorageDriver;

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
  fetch?: FetchLike;
}
export function s3(options: S3Options): StorageDriver;
```

Endpoints follow `docs/research/r2-platform-and-test-backends.md` §C.9:
`https://<account>.r2.cloudflarestorage.com`, or `https://<account>.<jurisdiction>.r2.cloudflarestorage.com`.

- [ ] **Step 1: Write the failing test**

`packages/cloudrop/src/storage/presets.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import type { FetchLike } from "./driver.ts";
import { r2, s3 } from "./presets.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function capture(): { fetch: FetchLike; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 404 });
    },
  };
}

describe("r2()", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names the missing setting and the environment variable that provides it", () => {
    vi.stubEnv("CLOUDROP_R2_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDROP_R2_ACCESS_KEY_ID", "");
    vi.stubEnv("CLOUDROP_R2_SECRET_ACCESS_KEY", "");
    expect(() => r2({ bucket: "media" })).toThrow(CloudropError);
    expect(() => r2({ bucket: "media" })).toThrow(/CLOUDROP_R2_ACCOUNT_ID/);
  });

  it("rejects an account ID that is not 32 hexadecimal characters", () => {
    expect(() => r2({ bucket: "media", accountId: "my-account", accessKeyId: "k", secretAccessKey: "s" })).toThrow(/32/);
  });

  it("reads credentials from the environment and signs for region auto", async () => {
    vi.stubEnv("CLOUDROP_R2_ACCOUNT_ID", ACCOUNT);
    vi.stubEnv("CLOUDROP_R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("CLOUDROP_R2_SECRET_ACCESS_KEY", "secret");
    const { fetch, requests } = capture();
    await r2({ bucket: "media", fetch }).head("a.txt");
    const url = new URL(requests[0]?.url ?? "");
    expect(url.host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe("/media/a.txt");
    expect(requests[0]?.headers.get("authorization")).toContain("/auto/s3/aws4_request");
  });

  it("uses the jurisdiction endpoint", async () => {
    const { fetch, requests } = capture();
    await r2({ bucket: "media", accountId: ACCOUNT, accessKeyId: "k", secretAccessKey: "s", jurisdiction: "eu", fetch }).head("a");
    expect(new URL(requests[0]?.url ?? "").host).toBe(`${ACCOUNT}.eu.r2.cloudflarestorage.com`);
  });
});

describe("s3()", () => {
  it("signs for the given endpoint and region", async () => {
    const { fetch, requests } = capture();
    await s3({ endpoint: "http://127.0.0.1:19000", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", fetch }).head("a");
    expect(requests[0]?.url).toBe("http://127.0.0.1:19000/b/a");
    expect(requests[0]?.headers.get("authorization")).toContain("/us-east-1/s3/aws4_request");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/cloudrop && bunx vitest run src/storage/presets.test.ts`
Expected: FAIL, `./presets.ts` not found.

- [ ] **Step 3: Implement**

`packages/cloudrop/src/storage/presets.ts`:

```ts
import { CloudropError } from "../errors.ts";
import { R2_RULES, S3_RULES } from "../rules.ts";
import type { FetchLike, StorageDriver } from "./driver.ts";
import { createS3Driver } from "./s3-driver.ts";

export interface R2Options {
  bucket: string;
  /** Default: env CLOUDROP_R2_ACCOUNT_ID. */
  accountId?: string;
  /** Default: env CLOUDROP_R2_ACCESS_KEY_ID. */
  accessKeyId?: string;
  /** Default: env CLOUDROP_R2_SECRET_ACCESS_KEY. */
  secretAccessKey?: string;
  jurisdiction?: "eu" | "fedramp";
  publicUrl?: string;
  fetch?: FetchLike;
}

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
  fetch?: FetchLike;
}

// Workers and browsers have no `process`; reading it guarded keeps the preset portable.
function fromEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name] || undefined;
}

function required(value: string | undefined, setting: string, envName: string): string {
  if (value) return value;
  throw new CloudropError("INVALID_CONFIG", `The R2 ${setting} is missing. Pass it to r2() or set ${envName}.`);
}

export function r2(options: R2Options): StorageDriver {
  const accountId = required(options.accountId ?? fromEnv("CLOUDROP_R2_ACCOUNT_ID"), "account ID", "CLOUDROP_R2_ACCOUNT_ID");
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw new CloudropError(
      "INVALID_CONFIG",
      "The R2 account ID must be 32 hexadecimal characters. Copy it from the R2 overview page in the Cloudflare dashboard.",
    );
  }
  const accessKeyId = required(options.accessKeyId ?? fromEnv("CLOUDROP_R2_ACCESS_KEY_ID"), "access key ID", "CLOUDROP_R2_ACCESS_KEY_ID");
  const secretAccessKey = required(
    options.secretAccessKey ?? fromEnv("CLOUDROP_R2_SECRET_ACCESS_KEY"),
    "secret access key",
    "CLOUDROP_R2_SECRET_ACCESS_KEY",
  );
  const host = options.jurisdiction
    ? `${accountId}.${options.jurisdiction}.r2.cloudflarestorage.com`
    : `${accountId}.r2.cloudflarestorage.com`;
  return createS3Driver({
    endpoint: `https://${host}`,
    region: "auto",
    bucket: options.bucket,
    credentials: { accessKeyId, secretAccessKey },
    rules: R2_RULES,
    publicUrl: options.publicUrl,
    fetch: options.fetch,
  });
}

export function s3(options: S3Options): StorageDriver {
  return createS3Driver({
    endpoint: options.endpoint,
    region: options.region,
    bucket: options.bucket,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    rules: S3_RULES,
    publicUrl: options.publicUrl,
    fetch: options.fetch,
  });
}
```

Replace `packages/cloudrop/src/index.ts`:

```ts
export { type CloudropErrorCode, CloudropError, type Result } from "./errors.ts";
export type {
  CompletedPart,
  FetchLike,
  ListedObject,
  ObjectInfo,
  ObjectOptions,
  PartInfo,
  PresignedRequest,
  StorageDriver,
  WriteOptions,
} from "./storage/driver.ts";
export { type R2Options, r2, type S3Options, s3 } from "./storage/presets.ts";
```

- [ ] **Step 4: Run to see it pass, and build**

Run: `cd packages/cloudrop && bunx vitest run src && cd ../.. && bun run fix && bun run check && bun run typecheck && bun run build`
Expected: PASS; build emits `dist/index.js` and `dist/index.d.ts` containing `r2` and `s3`.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudrop/src/storage/presets.ts packages/cloudrop/src/storage/presets.test.ts packages/cloudrop/src/index.ts
git commit -m "feat: add r2() and s3() storage presets"
```

---

### Task 10: Storage contract suite and the fake lane

**Files:**
- Create: `packages/cloudrop/test/contract/storage-contract.ts`, `packages/cloudrop/test/contract/fake.contract.test.ts`

**Interfaces:**
- Consumes: `StorageDriver`, `FetchLike` (Task 6), `createS3Driver` (Task 8), `createFakeR2` (Task 7), `R2_RULES`,
  `MiB` (Task 5), `crc32cBase64` (Task 4).
- Produces:

```ts
export interface ContractTarget {
  driver: StorageDriver;
  /** A driver whose signing clock runs `secondsAgo` behind, for expiry tests. */
  driverAt(secondsAgo: number): StorageDriver;
  /** Unique prefix for this run; everything under it is deleted afterwards. */
  prefix: string;
  /** Sends presigned requests the way a browser would. */
  http: FetchLike;
  capabilities: { enforcesSignedHeaders: boolean; rejectsUnequalParts: boolean; validatesChecksums: boolean; supportsListParts: boolean };
  dispose?(): Promise<void>;
}
export function describeStorageContract(name: string, connect: () => Promise<ContractTarget>): void;
export function randomPrefix(root: string): string;
```

Capability-gated tests call Vitest's `ctx.skip()`, so a lane that lacks a feature reports a skip, never a silent pass.

- [ ] **Step 1: Write the suite and the fake lane**

`packages/cloudrop/test/contract/storage-contract.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crc32cBase64 } from "../../src/checksum.ts";
import { MiB } from "../../src/rules.ts";
import type { FetchLike, StorageDriver } from "../../src/storage/driver.ts";
import { toHex } from "../../src/storage/sigv4.ts";

export interface ContractTarget {
  driver: StorageDriver;
  /** A driver whose signing clock runs `secondsAgo` behind, for expiry tests. */
  driverAt(secondsAgo: number): StorageDriver;
  /** Unique prefix for this run; everything under it is deleted afterwards. */
  prefix: string;
  /** Sends presigned requests the way a browser would. */
  http: FetchLike;
  capabilities: {
    enforcesSignedHeaders: boolean;
    rejectsUnequalParts: boolean;
    validatesChecksums: boolean;
    supportsListParts: boolean;
  };
  dispose?(): Promise<void>;
}

export function randomPrefix(root: string): string {
  return `${root}cloudrop-${toHex(crypto.getRandomValues(new Uint8Array(16)))}/`;
}

function bytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) out[index] = (index * 31 + seed) & 0xff;
  return out;
}

const etagOf = (response: Response): string => (response.headers.get("etag") ?? "").replaceAll('"', "");

export function describeStorageContract(name: string, connect: () => Promise<ContractTarget>): void {
  describe(`storage contract: ${name}`, () => {
    let target: ContractTarget;
    const openUploads: { key: string; uploadId: string }[] = [];
    const key = (suffix: string): string => `${target.prefix}${suffix}`;

    async function startUpload(suffix: string, metadata?: Record<string, string>): Promise<{ k: string; uploadId: string }> {
      const k = key(suffix);
      const created = await target.driver.createMultipart(k, { type: "application/octet-stream", metadata });
      if (created.error) throw created.error;
      openUploads.push({ key: k, uploadId: created.data.uploadId });
      return { k, uploadId: created.data.uploadId };
    }

    async function sendPart(k: string, uploadId: string, partNumber: number, body: Uint8Array<ArrayBuffer>, checksumCrc32c?: string) {
      const signed = await target.driver.presignPart(k, uploadId, partNumber, { size: body.length, expiresIn: 300, checksumCrc32c });
      if (signed.error) throw signed.error;
      return target.http(signed.data.url, { method: "PUT", headers: signed.data.headers, body });
    }

    beforeAll(async () => {
      target = await connect();
    });

    afterAll(async () => {
      if (!target) return;
      for (const upload of openUploads) await target.driver.abortMultipart(upload.key, upload.uploadId);
      for (let page = await target.driver.list(target.prefix); page.data?.items.length; page = await target.driver.list(target.prefix)) {
        const removed = await target.driver.deleteMany(page.data.items.map((item) => item.key));
        expect(removed.data?.failed).toEqual([]);
      }
      expect((await target.driver.list(target.prefix)).data?.items).toEqual([]);
      await target.dispose?.();
    });

    it("stores an object with type, disposition and metadata and reads a byte range", async () => {
      const k = key("plain.txt");
      const put = await target.driver.put(k, "hello world", {
        type: "text/plain",
        disposition: 'attachment; filename="plain.txt"',
        metadata: { "cloudrop-id": "f1" },
      });
      expect(put.error).toBeNull();
      expect((await target.driver.head(k)).data).toMatchObject({
        size: 11,
        type: "text/plain",
        disposition: 'attachment; filename="plain.txt"',
        metadata: { "cloudrop-id": "f1" },
      });
      const range = await target.driver.getRange(k, 0, 4);
      expect(new TextDecoder().decode(range.data ?? new Uint8Array())).toBe("hello");
    });

    it("reports a missing object as null and deletes idempotently", async () => {
      expect((await target.driver.head(key("missing.txt"))).data).toBeNull();
      expect((await target.driver.delete(key("missing.txt"))).error).toBeNull();
    });

    it("accepts a presigned PUT whose body matches the signed size and headers", async () => {
      const k = key("presigned.bin");
      const signed = await target.driver.presignPut(k, {
        size: 1024,
        expiresIn: 300,
        type: "application/octet-stream",
        metadata: { "cloudrop-id": "f2" },
        ifNoneMatch: true,
      });
      if (signed.error) throw signed.error;
      expect((await target.http(signed.data.url, { method: "PUT", headers: signed.data.headers, body: bytes(1024) })).status).toBe(200);
      expect((await target.driver.head(k)).data).toMatchObject({ size: 1024, metadata: { "cloudrop-id": "f2" } });
    });

    it("rejects presigned PUTs with a different size or content type", async (ctx) => {
      if (!target.capabilities.enforcesSignedHeaders) ctx.skip();
      const k = key("wrong.bin");
      const signed = await target.driver.presignPut(k, { size: 1024, expiresIn: 300, type: "image/png" });
      if (signed.error) throw signed.error;
      for (const length of [1023, 1025]) {
        const response = await target.http(signed.data.url, { method: "PUT", headers: signed.data.headers, body: bytes(length) });
        expect(response.status).toBe(403);
      }
      const html = await target.http(signed.data.url, {
        method: "PUT",
        headers: { ...signed.data.headers, "content-type": "text/html" },
        body: bytes(1024),
      });
      expect(html.status).toBe(403);
      expect((await target.driver.head(k)).data).toBeNull();
    });

    it("refuses to overwrite through a create-only URL", async () => {
      const signed = await target.driver.presignPut(key("create-only.bin"), { size: 16, expiresIn: 300, ifNoneMatch: true });
      if (signed.error) throw signed.error;
      const send = () => target.http(signed.data.url, { method: "PUT", headers: signed.data.headers, body: bytes(16) });
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(412);
    });

    it("rejects an expired presigned URL", async () => {
      const signed = await target.driverAt(120).presignPut(key("expired.bin"), { size: 16, expiresIn: 60 });
      if (signed.error) throw signed.error;
      const response = await target.http(signed.data.url, { method: "PUT", headers: signed.data.headers, body: bytes(16) });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("ExpiredRequest");
    });

    it("uploads equal parts through presigned URLs, completes once, and reports a retried completion", async () => {
      const { k, uploadId } = await startUpload("multipart.bin", { "cloudrop-id": "f3" });
      const sizes = [5 * MiB, 5 * MiB, 1 * MiB];
      const etags: string[] = [];
      for (const [index, size] of sizes.entries()) {
        const response = await sendPart(k, uploadId, index + 1, bytes(size, index));
        expect(response.status).toBe(200);
        etags.push(etagOf(response));
      }
      if (target.capabilities.supportsListParts) {
        const listed = await target.driver.listParts(k, uploadId);
        expect(listed.data?.map((part) => [part.partNumber, part.size, part.etag])).toEqual(sizes.map((size, i) => [i + 1, size, etags[i]]));
      }
      const parts = etags.map((etag, index) => ({ partNumber: index + 1, etag }));
      expect((await target.driver.completeMultipart(k, uploadId, parts, { ifNoneMatch: true })).error).toBeNull();
      expect((await target.driver.head(k)).data).toMatchObject({ size: 11 * MiB, metadata: { "cloudrop-id": "f3" } });
      expect((await target.driver.completeMultipart(k, uploadId, parts)).error?.code).toBe("NO_SUCH_UPLOAD");
    });

    it("rejects a larger last part at completion and accepts the repaired upload", async (ctx) => {
      if (!target.capabilities.rejectsUnequalParts) ctx.skip();
      const { k, uploadId } = await startUpload("unequal.bin");
      const first = etagOf(await sendPart(k, uploadId, 1, bytes(5 * MiB)));
      const tooLarge = etagOf(await sendPart(k, uploadId, 2, bytes(6 * MiB)));
      const rejected = await target.driver.completeMultipart(k, uploadId, [
        { partNumber: 1, etag: first },
        { partNumber: 2, etag: tooLarge },
      ]);
      expect(rejected.error?.code).toBe("INVALID_PART");
      const repaired = etagOf(await sendPart(k, uploadId, 2, bytes(4 * MiB)));
      const completed = await target.driver.completeMultipart(k, uploadId, [
        { partNumber: 1, etag: first },
        { partNumber: 2, etag: repaired },
      ]);
      expect(completed.error).toBeNull();
      expect((await target.driver.head(k)).data?.size).toBe(9 * MiB);
    });

    it("aborts a multipart upload idempotently", async () => {
      const { k, uploadId } = await startUpload("aborted.bin");
      expect((await target.driver.abortMultipart(k, uploadId)).error).toBeNull();
      expect((await target.driver.abortMultipart(k, uploadId)).error).toBeNull();
      if (target.capabilities.supportsListParts) {
        expect((await target.driver.listParts(k, uploadId)).error?.code).toBe("NO_SUCH_UPLOAD");
      }
    });

    it("rejects a part whose bytes do not match the signed CRC32C", async (ctx) => {
      if (!target.capabilities.validatesChecksums) ctx.skip();
      const { k, uploadId } = await startUpload("checksum.bin");
      const body = bytes(5 * MiB);
      expect((await sendPart(k, uploadId, 1, body, crc32cBase64(bytes(16)))).status).toBe(400);
      expect((await sendPart(k, uploadId, 1, body, crc32cBase64(body))).status).toBe(200);
      if (target.capabilities.supportsListParts) {
        expect((await target.driver.listParts(k, uploadId)).data?.[0]?.checksumCrc32c).toBe(crc32cBase64(body));
      }
    });

    it("copies an object with its type and metadata", async () => {
      await target.driver.put(key("copy-source.txt"), "copy me", { type: "text/plain", metadata: { "cloudrop-id": "f4" } });
      expect((await target.driver.copy(key("copy-source.txt"), key("copy-target.txt"))).error).toBeNull();
      expect((await target.driver.head(key("copy-target.txt"))).data).toMatchObject({
        size: 7,
        type: "text/plain",
        metadata: { "cloudrop-id": "f4" },
      });
    });

    it("lists by prefix in pages and deletes many keys with per-key results", async () => {
      const keys = ["list/a", "list/b", "list/c"].map(key);
      for (const k of keys) await target.driver.put(k, "x");
      const first = await target.driver.list(key("list/"), { limit: 2 });
      expect(first.data?.items.map((item) => item.key)).toEqual(keys.slice(0, 2));
      const second = await target.driver.list(key("list/"), { limit: 2, cursor: first.data?.nextCursor ?? undefined });
      expect(second.data?.items.map((item) => item.key)).toEqual(keys.slice(2));
      expect(second.data?.nextCursor).toBeNull();
      const everything = [...keys, key("list/never-existed")];
      const removed = await target.driver.deleteMany(everything);
      expect(removed.data?.failed).toEqual([]);
      expect(removed.data?.deleted.sort()).toEqual([...everything].sort());
    });
  });
}
```

`packages/cloudrop/test/contract/fake.contract.test.ts`:

```ts
import { R2_RULES } from "../../src/rules.ts";
import { createS3Driver } from "../../src/storage/s3-driver.ts";
import { createFakeR2 } from "../../src/testing/fake-r2.ts";
import { describeStorageContract } from "./storage-contract.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };

describeStorageContract("in-process fake", async () => {
  const fake = createFakeR2({ bucket: "contract", credentials });
  const driverAt = (secondsAgo: number) =>
    createS3Driver({
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "contract",
      credentials,
      rules: R2_RULES,
      fetch: fake.fetch,
      now: () => new Date(Date.now() - secondsAgo * 1000),
    });
  return {
    driver: driverAt(0),
    driverAt,
    prefix: "contract/",
    http: fake.fetch,
    capabilities: { enforcesSignedHeaders: true, rejectsUnequalParts: true, validatesChecksums: true, supportsListParts: true },
  };
});
```

- [ ] **Step 2: Run the fake lane**

Run: `cd packages/cloudrop && bunx vitest run test/contract/fake.contract.test.ts`
Expected: PASS, 12 tests, none skipped. A failure here is a driver or fake bug: fix the code, not the contract.

- [ ] **Step 3: Gates**

Run: `cd ~/projects/cloudrop && bun run fix && bun run check && bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/cloudrop/test/contract/storage-contract.ts packages/cloudrop/test/contract/fake.contract.test.ts
git commit -m "test: add the storage contract suite and run it against the fake"
```

---

### Task 11: Live R2 lane

**Files:**
- Create: `packages/cloudrop/test/contract/r2-live.contract.test.ts`, `scripts/test-live-r2.ts`
- Modify: `package.json` (root script `test:live`)

**Interfaces:**
- Consumes: `describeStorageContract`, `randomPrefix` (Task 10), `r2` (Task 9), `createS3Driver`, `R2_RULES`.
- Produces: `bun run test:live`, which needs `CLOUDROP_R2_ENV_FILE` pointing at a file of literal lines
  (`CLOUDROP_R2_*` or `BB_R2_*` names for `ACCOUNT_ID`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`). On this
  machine that file is `~/projects/linux-apps/app-d/.env.local` (object read/write token scoped to the
  test bucket, expires 2026-12-04). CI sets the four `CLOUDROP_R2_*` variables from repository secrets instead.

- [ ] **Step 1: Write the lane**

`packages/cloudrop/test/contract/r2-live.contract.test.ts`:

```ts
import { describe, it } from "vitest";
import { R2_RULES } from "../../src/rules.ts";
import { createS3Driver } from "../../src/storage/s3-driver.ts";
import { r2 } from "../../src/storage/presets.ts";
import { describeStorageContract, randomPrefix } from "./storage-contract.ts";

const env = process.env;

if (env.CLOUDROP_LIVE_R2 === "1") {
  describeStorageContract("live R2", async () => {
    const bucket = env.CLOUDROP_R2_BUCKET ?? "";
    const credentials = { accessKeyId: env.CLOUDROP_R2_ACCESS_KEY_ID ?? "", secretAccessKey: env.CLOUDROP_R2_SECRET_ACCESS_KEY ?? "" };
    const driverAt = (secondsAgo: number) =>
      createS3Driver({
        endpoint: `https://${env.CLOUDROP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        region: "auto",
        bucket,
        credentials,
        rules: R2_RULES,
        now: () => new Date(Date.now() - secondsAgo * 1000),
      });
    return {
      driver: r2({ bucket }),
      driverAt,
      prefix: randomPrefix("live-test/"),
      http: (input, init) => fetch(input, init),
      capabilities: { enforcesSignedHeaders: true, rejectsUnequalParts: true, validatesChecksums: true, supportsListParts: true },
    };
  });
} else {
  describe.skip("storage contract: live R2 (run `bun run test:live`)", () => {
    it("needs R2 credentials", () => {});
  });
}
```

`scripts/test-live-r2.ts`:

```ts
// Runs the live R2 contract lane. Credentials come from the file named by CLOUDROP_R2_ENV_FILE and go only into the
// child process environment; nothing here prints them.
import { readFileSync } from "node:fs";

const NAMES = {
  ACCOUNT_ID: "CLOUDROP_R2_ACCOUNT_ID",
  BUCKET: "CLOUDROP_R2_BUCKET",
  ACCESS_KEY_ID: "CLOUDROP_R2_ACCESS_KEY_ID",
  SECRET_ACCESS_KEY: "CLOUDROP_R2_SECRET_ACCESS_KEY",
} as const;

const file = process.env.CLOUDROP_R2_ENV_FILE;
if (!file) {
  console.error("Set CLOUDROP_R2_ENV_FILE to a file with CLOUDROP_R2_ACCOUNT_ID, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY.");
  process.exit(2);
}

const credentials: Record<string, string> = {};
for (const line of readFileSync(file, "utf8").split("\n")) {
  const match = /^(?:CLOUDROP|BB)_R2_([A-Z_]+)=(.*)$/.exec(line.trim());
  const target = match ? NAMES[match[1] as keyof typeof NAMES] : undefined;
  if (match && target) credentials[target] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
}
const missing = Object.values(NAMES).filter((name) => !credentials[name]);
if (missing.length > 0) {
  console.error(`Missing in ${file}: ${missing.join(", ")}.`);
  process.exit(2);
}

const child = Bun.spawn(["bunx", "vitest", "run", "test/contract/r2-live.contract.test.ts"], {
  cwd: new URL("../packages/cloudrop/", import.meta.url).pathname,
  env: { ...process.env, ...credentials, CLOUDROP_LIVE_R2: "1" },
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await child.exited);
```

Add to the root `package.json` scripts: `"test:live": "bun scripts/test-live-r2.ts"`.

- [ ] **Step 2: Run against the real test bucket**

```bash
cd ~/projects/cloudrop
CLOUDROP_R2_ENV_FILE=~/projects/linux-apps/app-d/.env.local bun run test:live
```

Expected: 12 tests pass, none skipped; the `afterAll` assertion proves the run's prefix is empty. Any failure is
evidence about R2: compare with `docs/research/r2-spike-findings.md`. If R2 behaves differently from the fake, fix the
fake to match R2 and record the finding in `docs/research/test-backends.md` (create it with a section per backend:
behaviour, evidence, date). If `head` fails because of `x-amz-checksum-mode`, drop that header (Task 8 note).

- [ ] **Step 3: Gates and commit**

```bash
bun run fix && bun run check && bun run typecheck && bun run test
git add packages/cloudrop/test/contract/r2-live.contract.test.ts scripts/test-live-r2.ts package.json
git commit -m "test: run the storage contract against real R2"
```

Add `docs/research/test-backends.md` and any fake fix to the commit if Step 2 produced them.

---

### Task 12: RustFS lane

**Files:**
- Create: `scripts/rustfs.sh`, `scripts/test-rustfs.sh`, `packages/cloudrop/test/contract/rustfs.contract.test.ts`

**Interfaces:**
- Consumes: `describeStorageContract`, `randomPrefix` (Task 10), `createS3Driver`, `signRequest`, `EMPTY_SHA256`,
  `S3_RULES`.
- Produces: `scripts/test-rustfs.sh` starts `rustfs/rustfs:1.0.5` on `127.0.0.1:${CLOUDROP_RUSTFS_PORT:-19000}`,
  runs the lane and always removes the container.

- [ ] **Step 1: Write the scripts**

`scripts/rustfs.sh`:

```bash
#!/usr/bin/env bash
# Starts or stops a disposable RustFS container for the S3 contract lane.
set -euo pipefail
NAME=cloudrop-test-rustfs
PORT="${CLOUDROP_RUSTFS_PORT:-19000}"
case "${1:-}" in
  up)
    docker run -d --rm --name "$NAME" --label cloudrop.test=rustfs -p "127.0.0.1:${PORT}:9000" \
      -e RUSTFS_ACCESS_KEY=cloudrop-test -e RUSTFS_SECRET_KEY=cloudrop-test-secret \
      rustfs/rustfs:1.0.5 >/dev/null
    for _ in $(seq 1 60); do
      if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then
        echo "RustFS is listening on http://127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 1
    done
    echo "RustFS did not start within 60 seconds. Check: docker logs ${NAME}" >&2
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "RustFS container removed"
    ;;
  *)
    echo "Usage: scripts/rustfs.sh up|down" >&2
    exit 2
    ;;
esac
```

`scripts/test-rustfs.sh`:

```bash
#!/usr/bin/env bash
# RustFS contract lane. The trap removes the container on success, failure and interrupt.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'scripts/rustfs.sh down' EXIT
ss -ltn "sport = :${CLOUDROP_RUSTFS_PORT:-19000}" | grep -q LISTEN && {
  echo "Port ${CLOUDROP_RUSTFS_PORT:-19000} is in use. Set CLOUDROP_RUSTFS_PORT to a free port." >&2
  exit 1
}
scripts/rustfs.sh up
cd packages/cloudrop
CLOUDROP_RUSTFS_ENDPOINT="http://127.0.0.1:${CLOUDROP_RUSTFS_PORT:-19000}" bunx vitest run test/contract/rustfs.contract.test.ts
```

Run `chmod +x scripts/rustfs.sh scripts/test-rustfs.sh`.

`packages/cloudrop/test/contract/rustfs.contract.test.ts`:

```ts
import { describe, it } from "vitest";
import { S3_RULES } from "../../src/rules.ts";
import { createS3Driver } from "../../src/storage/s3-driver.ts";
import { EMPTY_SHA256, signRequest } from "../../src/storage/sigv4.ts";
import { describeStorageContract, randomPrefix } from "./storage-contract.ts";

const endpoint = process.env.CLOUDROP_RUSTFS_ENDPOINT;
const credentials = { accessKeyId: "cloudrop-test", secretAccessKey: "cloudrop-test-secret" };
const region = "us-east-1";
const bucket = "contract";

async function ensureBucket(base: string): Promise<void> {
  const url = new URL(`${base}/${bucket}`);
  const headers = await signRequest({ method: "PUT", url, credentials, region, date: new Date(), payloadHash: EMPTY_SHA256 });
  const response = await fetch(url, { method: "PUT", headers });
  if (!response.ok && response.status !== 409) throw new Error(`Creating the RustFS bucket failed with HTTP ${response.status}.`);
}

if (endpoint) {
  describeStorageContract("RustFS", async () => {
    await ensureBucket(endpoint);
    const driverAt = (secondsAgo: number) =>
      createS3Driver({ endpoint, region, bucket, credentials, rules: S3_RULES, now: () => new Date(Date.now() - secondsAgo * 1000) });
    return {
      driver: driverAt(0),
      driverAt,
      prefix: randomPrefix("contract/"),
      http: (input, init) => fetch(input, init),
      // RustFS follows AWS S3, which allows unequal parts; R2's equal-part rule is covered by the fake, Wrangler and live lanes.
      capabilities: { enforcesSignedHeaders: true, rejectsUnequalParts: false, validatesChecksums: true, supportsListParts: true },
    };
  });
} else {
  describe.skip("storage contract: RustFS (run scripts/test-rustfs.sh)", () => {
    it("needs a RustFS endpoint", () => {});
  });
}
```

- [ ] **Step 2: Run the lane**

Run: `cd ~/projects/cloudrop && scripts/test-rustfs.sh`
Expected: the container starts, 11 tests pass and 1 is skipped (unequal parts), the container is removed. Then
`docker ps -a --filter label=cloudrop.test` lists nothing.

If the container rejects the credentials (`InvalidAccessKeyId`), read the RustFS README "Docker Quick Start" for the
current environment variable names and fix `scripts/rustfs.sh`. If a contract test fails because RustFS deviates from
S3 (not because of cloudrop), set the matching capability to `false` with a one-line comment naming the observed
response, and record it in `docs/research/test-backends.md`.

- [ ] **Step 3: Commit**

```bash
git add scripts/rustfs.sh scripts/test-rustfs.sh packages/cloudrop/test/contract/rustfs.contract.test.ts
git commit -m "test: run the storage contract against RustFS"
```

Include `docs/research/test-backends.md` if Step 2 changed it.

---

### Task 13: Wrangler local R2 lane

**Files:**
- Create: `packages/cloudrop/test/wrangler/wrangler.jsonc`, `packages/cloudrop/test/wrangler/worker.ts`,
  `scripts/test-wrangler.sh`, `packages/cloudrop/test/contract/wrangler.contract.test.ts`

**Interfaces:**
- Consumes: `describeStorageContract`, `randomPrefix`, `createS3Driver`, `R2_RULES`.
- Produces: `scripts/test-wrangler.sh`, which starts `wrangler dev` with the experimental local S3 endpoint
  (`http://127.0.0.1:${CLOUDROP_WRANGLER_PORT:-18787}/cdn-cgi/local/r2/s3`), runs the lane and always stops Wrangler
  and deletes its state. Setup per https://developers.cloudflare.com/r2/local-development/ and
  `docs/research/r2-platform-and-test-backends.md` §B.3.

- [ ] **Step 1: Write the Worker, the script and the lane**

`packages/cloudrop/test/wrangler/wrangler.jsonc`:

```jsonc
{
  "name": "cloudrop-contract",
  "main": "worker.ts",
  "compatibility_date": "2026-11-01",
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "contract",
      "local_dev": {
        "experimental_s3_credentials": { "accessKeyId": "cloudrop-local", "secretAccessKey": "cloudrop-local-secret" }
      }
    }
  ]
}
```

`packages/cloudrop/test/wrangler/worker.ts`:

```ts
// The Worker only exists so Wrangler serves the local R2 S3 endpoint; the contract talks to that endpoint.
export default { fetch: (): Response => new Response("cloudrop contract worker") };
```

`scripts/test-wrangler.sh`:

```bash
#!/usr/bin/env bash
# Wrangler local R2 contract lane. The trap stops Wrangler and deletes its state on success, failure and interrupt.
set -euo pipefail
cd "$(dirname "$0")/../packages/cloudrop"
PORT="${CLOUDROP_WRANGLER_PORT:-18787}"
STATE=test/wrangler/.state
if ss -ltn "sport = :${PORT}" | grep -q LISTEN; then
  echo "Port ${PORT} is in use. Set CLOUDROP_WRANGLER_PORT to a free port." >&2
  exit 1
fi
bunx wrangler@4.162.0 dev --config test/wrangler/wrangler.jsonc --ip 127.0.0.1 --port "$PORT" \
  --persist-to "$STATE" --log-level warn &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true; wait "$WRANGLER_PID" 2>/dev/null || true; rm -rf "$STATE"' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:${PORT}/" && break
  sleep 1
done
CLOUDROP_WRANGLER_ENDPOINT="http://127.0.0.1:${PORT}/cdn-cgi/local/r2/s3" bunx vitest run test/contract/wrangler.contract.test.ts
```

Run `chmod +x scripts/test-wrangler.sh`.

`packages/cloudrop/test/contract/wrangler.contract.test.ts`:

```ts
import { describe, it } from "vitest";
import { R2_RULES } from "../../src/rules.ts";
import { createS3Driver } from "../../src/storage/s3-driver.ts";
import { describeStorageContract, randomPrefix } from "./storage-contract.ts";

const endpoint = process.env.CLOUDROP_WRANGLER_ENDPOINT;
const credentials = { accessKeyId: "cloudrop-local", secretAccessKey: "cloudrop-local-secret" };

if (endpoint) {
  describeStorageContract("Wrangler local R2", async () => {
    const driverAt = (secondsAgo: number) =>
      createS3Driver({
        endpoint,
        region: "auto",
        bucket: "contract",
        credentials,
        rules: R2_RULES,
        now: () => new Date(Date.now() - secondsAgo * 1000),
      });
    return {
      driver: driverAt(0),
      driverAt,
      prefix: randomPrefix("contract/"),
      http: (input, init) => fetch(input, init),
      // Research §B.3: the local endpoint ignores checksum headers and does not implement ListParts.
      capabilities: { enforcesSignedHeaders: true, rejectsUnequalParts: true, validatesChecksums: false, supportsListParts: false },
    };
  });
} else {
  describe.skip("storage contract: Wrangler local R2 (run scripts/test-wrangler.sh)", () => {
    it("needs the local endpoint", () => {});
  });
}
```

- [ ] **Step 2: Run the lane**

Run: `cd ~/projects/cloudrop && scripts/test-wrangler.sh`
Expected: Wrangler starts, the lane runs, Wrangler stops and `packages/cloudrop/test/wrangler/.state` is gone.

Interpret failures by evidence, not by guesswork:
- Every request `403 SignatureDoesNotMatch`: the emulator may sign a different path. Read
  `packages/miniflare/src/workers/r2/s3/auth.worker.ts` in https://github.com/cloudflare/workers-sdk (the file the
  research cites) to see which path it signs, and adjust only the lane's `endpoint`.
- The wrong-size or content-type test fails: set `enforcesSignedHeaders: false` with the observed status in a comment.
- Any other emulator gap: set the matching capability to `false` with the observed response in a comment.
- Record every deviation in `docs/research/test-backends.md` under "Wrangler 4.162.0 local R2".

- [ ] **Step 3: Commit**

```bash
git add packages/cloudrop/test/wrangler/wrangler.jsonc packages/cloudrop/test/wrangler/worker.ts \
  scripts/test-wrangler.sh packages/cloudrop/test/contract/wrangler.contract.test.ts
git commit -m "test: run the storage contract against Wrangler's local R2 endpoint"
```

Include `docs/research/test-backends.md` if Step 2 changed it.

---

### Task 14: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts (Task 1), `scripts/test-rustfs.sh` (Task 12), `scripts/test-wrangler.sh` (Task 13), the live
  lane (Task 11).
- Produces: jobs `check` (every push and pull request), `rustfs` and `wrangler` (after `check`), `live-r2` (nightly and
  manual only; needs repository secrets `CLOUDROP_R2_ACCOUNT_ID`, `CLOUDROP_R2_BUCKET`, `CLOUDROP_R2_ACCESS_KEY_ID`,
  `CLOUDROP_R2_SECRET_ACCESS_KEY`). All jobs run on GitHub-hosted `ubuntu-latest`: this repository has no self-hosted
  runner, and npm trusted publishing (M6) requires hosted runners.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: bun install --frozen-lockfile
      - run: bun run check
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build

  rustfs:
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: bun install --frozen-lockfile
      - run: scripts/test-rustfs.sh

  wrangler:
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: bun install --frozen-lockfile
      - run: scripts/test-wrangler.sh

  live-r2:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    needs: check
    runs-on: ubuntu-latest
    env:
      CLOUDROP_LIVE_R2: "1"
      CLOUDROP_R2_ACCOUNT_ID: ${{ secrets.CLOUDROP_R2_ACCOUNT_ID }}
      CLOUDROP_R2_BUCKET: ${{ secrets.CLOUDROP_R2_BUCKET }}
      CLOUDROP_R2_ACCESS_KEY_ID: ${{ secrets.CLOUDROP_R2_ACCESS_KEY_ID }}
      CLOUDROP_R2_SECRET_ACCESS_KEY: ${{ secrets.CLOUDROP_R2_SECRET_ACCESS_KEY }}
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: bun install --frozen-lockfile
      - name: Live R2 contract
        working-directory: packages/cloudrop
        run: |
          if [ -z "$CLOUDROP_R2_SECRET_ACCESS_KEY" ]; then
            echo "Repository secrets CLOUDROP_R2_* are not set; add them to run the live lane." >&2
            exit 1
          fi
          bunx vitest run test/contract/r2-live.contract.test.ts
```

- [ ] **Step 2: Validate locally**

Run: `cd ~/projects/cloudrop && bun run check` (Biome also formats YAML-free JSON only; the workflow is checked by
GitHub on push). Read the file once more against the four job names in **Interfaces**.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add check, RustFS, Wrangler and nightly live R2 lanes"
```

Pushing and adding the four repository secrets are owner actions; ask before doing either.

---

## Definition of done for M1

- `bun run check`, `bun run typecheck`, `bun run test` and `bun run build` pass.
- The fake lane runs 12 contract tests with no skips; the live R2 lane passes on the test bucket and leaves its prefix
  empty; the RustFS and Wrangler lanes pass with only documented capability skips.
- `docker ps -a --filter label=cloudrop.test` shows nothing, no Wrangler process from this repository is running, and
  no scratch files remain.
- `docs/research/test-backends.md` records every observed backend deviation, if any.
