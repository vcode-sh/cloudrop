# M12-E: server refusals

Rulings for how the server refuses and what a client can read from a refusal: a `CloudropError` returned from
`authorize`, `rateLimited(seconds)`, `Retry-After` on the 200 that refuses a file, `kind` on a content refusal, and
`BUCKET_BLOCKED` for a bucket the browser cannot reach, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md`
§2.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-E7: `BUCKET_BLOCKED` when the browser sends no byte to the bucket while the upload server answers

- **Decision:** a part, or a single `PUT`, fails at once with the client code `BUCKET_BLOCKED`, not retryable, when
  two consecutive attempts of it ended in XHR `onerror` with no upload progress (`loaded > 0` never seen), a `/sign`
  of that part answered 2xx between them (the second attempt used a URL the server had just signed), and
  `navigator.onLine` is not `false`. Only on the XHR path: with a `fetch` option, or where there is no
  XMLHttpRequest, nothing changes. cloudrop's own stall abort and `ontimeout` are never counted, nor is an XHR whose
  `open()` or `send()` throws, nor an empty body: a 0-byte file has no byte to report, so a bad signature or an
  expired URL on it would look blocked, and it keeps the six attempts and `NETWORK_ERROR`. The code is in `ClientErrorCode`, so the server's status table cannot hold it, and in
  `KEEPS_TICKET`: `retry()` after the rule is fixed sends only what had not landed. The message names the CORS rule
  and `npx cloudrop doctor --origin <origin>`, and says that a firewall or extension looks the same.
- **Why:** spec 1.0 §2d. A missing or wrong CORS rule is the most common newcomer mistake, and it showed as a
  retryable `NETWORK_ERROR` after about 15 s. A rule that misses the origin or a signed header fails the preflight, so
  the body never leaves. Measured on R2 from Chromium 159 (`r2-spike-findings.md`, "Missing CORS origin and bad
  signature from a browser, 2026-11-22"): a page on an origin the rule does not list got `403` on each preflight, no
  upload progress event, and ended `BUCKET_BLOCKED` in 154 ms (1 MiB) and 456 ms (14 B); a bad signature on a
  14-byte body reported `upload.progress` of 14 before its `onerror`, so it keeps the old six attempts and
  `NETWORK_ERROR`. No condition on the time to the first failure is needed, so there is no `M12-E8`.
- **False positives:** a firewall, proxy or extension that blocks only the storage host fires the rule, correctly:
  retrying cannot help, and the message names that cause. A connection refused or reset before the first progress
  event, twice in a row around a successful `/sign`, also fires it, while a later attempt might have passed: the
  browser lane's reset rows (reset after 1 MiB) still end `NETWORK_ERROR` after six attempts, so Chromium reports
  progress first there, but a bucket host that refuses connections outright looks like a blocked host. The example
  lab's network-error faults report half the body as sent before the error, so they keep the six-attempt demo, and a
  separate held fault, "Block every bucket PUT as a CORS rule that misses this page would", sends no byte and ends in
  `BUCKET_BLOCKED` (coordinator's ruling, fix round 1).
- **If wrong:** a page whose bucket is reachable but flaky in that way gets a non-retryable code where a retry would
  have passed; `retry()` still works, with the same ticket. Not measured yet: Firefox and Safari, whose progress
  events may differ (spec 1.0 §2d, before release).
- **Status:** in force. Closes the plans README's open decision "Unreadable R2 refusals" for the CORS case; a
  bad-signature `403` stays a `NETWORK_ERROR`.
- **Visible in:** `src/client/transport.ts`, `src/client/bucket.ts`, `src/client/parts.ts`, `src/client/failures.ts`,
  `src/client/retry-step.ts`, `src/errors.ts`, `src/client/bucket-blocked.test.ts`,
  `examples/next/app/bucket-faults.chaos.browser.test.ts`, `examples/next/app/lab-blocked.browser.test.ts`,
  `examples/next/app/lab/lab-xhr.ts`, `docs/guide/errors.md`, `docs/guide/troubleshooting.md`,
  `docs/guide/client.md`, base spec §6.2.
