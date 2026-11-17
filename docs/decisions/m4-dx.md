# M4a decisions: audit fixes, developer experience and React hooks

Design: [`2026-11-17-m4-dx-and-react-design.md`](../superpowers/specs/2026-11-17-m4-dx-and-react-design.md). Each
entry: decision, why, what it costs if wrong, status, source, where it is visible. `M4-F<n>` numbers follow the design's
§3 to §5; `M4-B<n>` follow §6. Execution rulings continue each series from the next free number.

## Fixes and developer experience (`M4-F`)

### Client (design §3, `M4-F1` to `M4-F9`)

### M4-F1: a failed multipart file keeps its record for a reload, without `/abort`

- **Decision:** a failed file whose ticket is multipart and whose client keeps records (persistence on, with
  `indexedDB` and Web Locks) gives its ticket up without `/abort`: the ticket is marked dropped, the lock is let go and
  the record stays, so a reload lists the upload and `resume()` sends only the parts the bucket lacks. This is what a
  failure of `upload()` does at once, and what `pagehide` does to a failed file of `start()` (and of `resume()`). A
  dropped ticket sends no later `/abort` from this page: `abort()` of the file, `job.abort()` and the caller's signal
  then only settle it `aborted`. A single `PUT`, and every ticket of a client that keeps no records, still sends
  `/abort` (`M3-S15`); the caller's `abort()` of a failed file that still holds its ticket still sends it (`M3-U32`).
- **Why:** design §3 F1. A resumed 10 GB upload whose parts all failed (the network gone without an `offline` event)
  ended `failed`; the reload a user makes to recover then fired `pagehide`, whose `/abort` deleted the parts and the
  record, so every byte was sent again. `/abort` is needed for a single `PUT`, whose object no lifecycle rule removes;
  multipart parts nobody resumes are removed by the bucket's abort-incomplete-multipart rule. A given-up ticket must not
  `/abort` later: another tab may resume and complete the upload, and an `/abort` with a live token would then delete
  the finished object (the `M3-U88` hazard).
- **If wrong:** parts of a failed upload nobody resumes stay in the bucket until the lifecycle rule removes them (a day
  on the recommended rule) instead of at once, and a plugin's `onAbort` hook does not run for them. "Keeps records" is
  read from the client (`records.enabled`), not from the record's own save: where the browser refuses the lock request
  (`M3-U88`) or can no longer read the file to hash it, nothing was saved and still no `/abort` is sent, so those
  parts too wait for the lifecycle rule. After a back-forward cache restore, `abort()` of a given-up file leaves its
  record listed until it expires or `forget()` runs.
- **Status:** in force. Amends `M3-S15`, `M3-U29` and `M3-U33`.
- **Source:** design §3 F1; code audit of `main` at `907cc77`.
- **Visible in:** `client/file-run.ts` (`giveUp`, `end`), `client.ts` (`leftovers`), `client/lifecycle.ts`,
  `client/persist.test.ts` (the `pagehide` row), `client/persist-failures.test.ts` (the `upload()` rows),
  `docs/guide/client.md` ("What gets cleaned up"), `docs/guide/resume.md` ("When a record is deleted").

<!-- Task A appends its entries above this line. -->

### Server and storage (design §4, `M4-F10` to `M4-F14`)

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

<!-- Task D appends its entries above this line. -->
