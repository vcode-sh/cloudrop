# M3 progress and pool, plan B: implementation plan

**Status: done.** `cloudrop/client`: `concurrency: "auto"` (a pool that sizes itself from 4 up to 8 and halves on
network errors, stalls and busy answers), `order: "smallest-first"`, stalled PUTs given up after 30 s, pause on
`offline` and resume on `online`, `retry()` of a file or a job that keeps a failed file's ticket and parts
(`pagehide` frees them), and files of 256 MiB or more at 16 MiB parts after a measurement on live R2. Executed
2026-11-16, `fbc5c15..220332c`. Decisions: `docs/decisions/m3-uploader.md` (`M3-U23` to `M3-U58`). Design:
[`2026-11-16-progress-scheduler-design.md`](../specs/2026-11-16-progress-scheduler-design.md). Code:
`packages/cloudrop/src/client/`, `packages/cloudrop/src/plan.ts`.

The code is the truth. The plan's full text: `git show 220332c:docs/superpowers/plans/2026-11-16-m3-progress-plan-b.md`.
Where the project stands now: [`README.md`](README.md).
