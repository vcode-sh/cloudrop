# Performance checks

Uploads are network-bound: bytes go from the client to the bucket and the server only signs (spec section 11.1). CPU
matters in signing, client-side checksums and part planning. Order of impact: network round trips and waterfalls, then
bundle size, then hot-path allocations, then micro-optimizations. **Measure before optimizing anything below the first
two**, and put the number in the commit or report. A speed claim with no number is marked unverified.

## Library hot paths

Hot paths: SigV4 signing and presigning, checksums, part planning, the upload scheduler.

| Level | Rule |
| --- | --- |
| MUST | No per-byte allocation: process buffers as `Uint8Array` views (`subarray`), never one object or string per byte or per chunk when a view works. |
| MUST | Derive the SigV4 signing key once per credential, date, region and service, not per request. |
| MUST | Independent awaits run together (`Promise.all`); sequential `await` only when the second needs the first. Part uploads are bounded by the scheduler's concurrency, never an unbounded `Promise.all` over every part. |
| MUST | Every outbound call can be aborted: accept an `AbortSignal`, and give storage calls a default timeout. |
| MUST | Stream or slice large bodies; never read a whole multi-GiB `File` or response into memory. |
| SHOULD | Prefer `crypto.subtle` for hashes it provides (SHA-256). CRC32C runs in JavaScript; it was measured at about 916 MiB/s (spec section 11.1), so do not rewrite it without a new measurement. |
| SHOULD | A table or cache earns its place with a measurement and a comment naming the case it speeds up. |

## Bundle size

The client plus React target is under about 8 kB gzip (spec section 1); each subpath ships only what it imports.

| Level | Rule |
| --- | --- |
| MUST | A server-only module is never imported by a client subpath entry (and the reverse); check the packed output when an import graph changes. |
| MUST | Import from the defining module, not a barrel. No side effects at module top level (it breaks tree shaking and Workers cold starts): no I/O, no work done at import. |
| SHOULD | Check the size of a subpath before and after a change that adds code to it. Do not claim a size without a run. |
| SHOULD | No dependency for what the platform ships (see [dependencies.md](dependencies.md)). |

## WebAssembly

Only behind a benchmark that shows the JavaScript path is the bottleneck on real target devices (spec section 11.1):
lazy-loaded, optional, with a JavaScript fallback of identical output. No native Node addons.

## How to measure

- Throughput of a function: a Vitest bench or a script that runs it on realistic input sizes (16 MiB parts for
  checksums) and reports MiB/s. Record the machine, runtime and version with the number. Vitest bench is unverified
  here: check it before relying on it.
- Allocation and memory: run the script with the runtime's heap statistics before and after (runtime-specific; say
  which one you used).
- Bundle: the built subpath output size, raw and gzip, before and after.
- Type-check cost: `bun run typecheck` time before and after; a jump points at inference, fixed by an explicit
  exported type.
