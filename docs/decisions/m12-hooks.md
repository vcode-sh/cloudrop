# M12-H: React start errors and completion callbacks

Rulings for `useUpload`'s `startError`, `onUploaded` and `onError`, so a start the client refuses reaches the hook and
an app learns when a file ends, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md` §1.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-H1: `onUploaded` and `onError` are `useUpload` options, route-wide, detected in the route's store

- **Decision:** `UseUploadOptions<TMetadata, R>` gains `onUploaded(file)`, with the done outcome
  `{ id, name, status: "done", result }` typed by the route's `onComplete`, and `onError(error)`. The route's store
  (`src/react/upload-store.ts`) finds the ends while it builds its view: a file whose status became `done` or `failed`
  since the previous snapshot it kept in `made` is one event, once per store, so once whichever component started it.
  A failed file's error always names the file: when the whole `/upload` was refused the job's error, which names none,
  is copied with `file` set. A start refused without a file row is an `onError` event too, with `error.file`
  undefined (M12-H2). A cancel is neither. The store's `onEnd(listener)` hears the events of one publish in one
  microtask after the view's listeners ran; each hook registers there in a `useEffect` and calls the callbacks of its
  latest committed render (`controller.latest`, set in `useInsertionEffect`). A listener that throws is thrown again
  in a `setTimeout` and the others still run, as the client's job listeners do (M3-U8). `cloudrop/react` measured
  2.61 kB (gzip, size-limit) against 2.25 kB before, under its 4 kB ceiling.
- **Why:** spec 1.0 §1: the pilot compared `totals.done` with a ref to refresh its queries, and every surveyed library
  has success and error callbacks. In the store rather than per hook, so two components do not each diff the jobs and
  the event exists once; in an effect, so StrictMode's double effect leaves one listener per mounted hook; in a
  microtask, so a callback that calls `upload()` or `retry()` runs outside the store's own notify.
- **If wrong:** an app that wants one call per file across the whole route, not per mounted component, gives the
  callback to one component only, as the guide says. A file that ends while it is being rendered by two components
  calls each one's callback: that is the contract, not a duplicate.
- **Status:** in force.
- **Visible in:** `src/react/types.ts`, `src/react/upload-store.ts`, `src/react/use-upload.ts`,
  `src/react/use-upload-callbacks.test.ts`, `src/react/types.test.ts`, `docs/guide/react.md`.

### M12-H2: `startError` is per route, set only by the route's latest start

- **Decision:** `UseUploadResult.startError` is the route's last start refused before it had a file row
  (`CLIENT_CLOSED`, `INVALID_INPUT` for the arguments, `INVALID_CONFIG`), or `null`. Every start through the route's
  hooks, `upload()`, a pick, a drop or `resumeUpload()`, takes the store's next sequence number (`begin()`), which
  clears `startError`; a refusal sets it only when its number is still the latest (`refuse(seq, error)`), and still
  reaches `onError` when it is not. `clear()` clears it too. `upload(null)` and an empty list start nothing and keep
  it. A pick or a drop with a wrong client option now goes through `upload()` as well, so it sets `startError`, and is
  still thrown in a task (M3-U8).
- **Why:** spec 1.0 §1: a pick or a drop drops `upload()`'s promise, so a start the client refused before any file row
  existed reached nothing on the page (M11-R6); the pilot wrapped `start` and `resume` in 68 lines
  (`watchStartRefusals`) to keep the route's last refusal. Per route like `files`, so every component that shows the
  route's list shows its refusal; the sequence number keeps an older start's late refusal from replacing a newer
  start's state.
- **If wrong:** a page that wants the refusal per component reads `upload()`'s own result instead. A start that is
  refused with rows (any `/upload` refusal) never sets `startError`: its rows already show it.
- **Status:** in force.
- **Visible in:** `src/react/types.ts`, `src/react/upload-store.ts`, `src/react/use-upload.ts`,
  `src/react/use-upload-callbacks.test.ts`, `src/react/upload-store.test.ts`, `docs/guide/react.md`.

### M12-H3: no late reports after a remount

- **Decision:** when the store gains its first React listener, it rebuilds its view as a baseline (`build()` with no
  event list in `subscribe()`): every file's current status is recorded in `made` and reported to nobody. A file that
  ended while no component on the route was mounted, or while its components were hidden by `<Activity>`, is never
  reported; its row in `files` shows the outcome.
- **Why:** spec 1.0 §1: a late report would fire `onUploaded` for work the page already reflects through `files`, at a
  time the app cannot tell from a fresh end, such as a toast for an upload that finished minutes ago on another page.
- **If wrong:** an app that must react to every end, mounted or not, follows the jobs with the client's
  `job.subscribe` or `job.done`, which the hooks do not change; or it compares `files` on mount itself.
- **Status:** in force.
- **Visible in:** `src/react/upload-store.ts`, `src/react/use-upload-callbacks.test.ts`.
