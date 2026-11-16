# M3 progress and pool, plan A

**Status: done.** `cloudrop/client`: bucket PUTs through XHR with progress, bytes that never go backwards, EWMA speed
and ETA, the throttled snapshot (`subscribe`, `getSnapshot`), one connection pool per client (`concurrency`), several
files per job (`start()`, `UploadResult`, `error.file`), pause, resume and cancel per file and job, and the `/lab`
page. Executed 2026-11-16, `a5de46a..a003cdb`. Decisions: `docs/decisions/m3-uploader.md` (`M3-U1` to `M3-U22`).
Design: [`2026-11-16-progress-scheduler-design.md`](../specs/2026-11-16-progress-scheduler-design.md). Code:
`packages/cloudrop/src/client/`.

The code is the truth. The plan's full text: `git show a003cdb:docs/superpowers/plans/2026-11-16-m3-progress-plan-a.md`.
Where the project stands now: [`README.md`](README.md).
