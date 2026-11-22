# M12-R: the review of every area before 1.0.0

Findings of the area-by-area review before 1.0.0 and what was done with each, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §10. A finding is proven with a failing test or a measurement before
it is fixed.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-R50: `createUploadHooks` reads options that are not an object as a wrong option

- **Decision:** `createUploadHooks(options)` reads its argument with `optionsOf` (`src/input.ts`, M11-R245): null and
  undefined are no options (M11-R7), a plain object is the options, and anything else, such as the basePath alone or
  a function, is a wrong option. The hooks then behave as for any wrong option: `upload()`, `resumeUpload()` and
  `refresh()` resolve `INVALID_CONFIG` with "Pass createUploadHooks the client's options as an object, such as
  { basePath: "/api/cloudrop" }, or { client } to share a client.", a start's refusal reaches `startError` and
  `onError`, a pick or a drop also throws it in a task, and `close()` resolves.
- **Why:** review r13 E1. From plain JavaScript, `createUploadHooks("/api/cloudrop")` made `upload()`, a pick, a drop
  and `close()` throw `TypeError: Cannot use 'in' operator to search for 'client' in /api/cloudrop` synchronously, out
  of React's `onChange` after the start had begun; a function was read as an object with no options and ignored, so
  uploads went to the default basePath. Every other public call resolves `{ data, error }`.
- **If wrong:** an app that passed a non-object and relied on the defaults now gets `INVALID_CONFIG` at its first
  upload. The types never allowed it. `createCloudropClient("/api/cloudrop")` itself still accepts the string and
  ignores it: that is area A's (r13 E1 notes it), not changed here.
- **Status:** in force. `src/react.test.ts`, a string and a function as options: before the fix the string threw that
  `TypeError` and the function's upload answered `NETWORK_ERROR` with no `startError`.
- **Visible in:** `src/react.ts`, `src/react.test.ts`, `docs/guide/react.md` (Set up).

### M12-R51: `useUpload().upload(file, options)` hands options that are not an object to the client

- **Decision:** `upload(files, call)` reads `metadata` from `call` only when `call` is a plain object (`undefined`
  counts as `{}`). Any other value, null included, goes to `client.start` unchanged, which refuses it with
  `INVALID_INPUT` "Pass the upload options as an object, such as { metadata, signal }." (`client/arguments.ts`).
  That refusal has no file row, so it reaches `startError` and `onError` like any other refused start (M12-H2).
- **Why:** review r13 E2. `upload(file, null)` threw `TypeError: Cannot use 'in' operator to search for 'metadata' in
  null`, because the default `call = {}` covers only `undefined`. The guide says a wrong argument resolves
  `INVALID_INPUT`, and the client's own `upload()` already refuses it so. Handing the value on keeps one place, the
  client, that words the refusal.
- **If wrong:** nothing in the types allowed null; a JavaScript caller that passed it now gets `INVALID_INPUT` instead
  of a throw, and no request is sent.
- **Status:** in force. `src/react/use-upload.test.ts`, null and a string as options: both threw that `TypeError`
  before the fix.
- **Visible in:** `src/react/use-upload.ts`, `src/react/use-upload.test.ts`, `docs/guide/react.md` (Start uploads
  yourself).

### M12-R52: `refresh()`'s `INVALID_CONFIG` is not a start refusal; the guide was wrong

- **Decision:** the code stays: `useResumable().refresh()` resolves `INVALID_CONFIG` for a wrong client option and
  sets neither `startError` nor `onError`. The guide now says the error reaches `startError` and `onError` for
  `upload()` and `resumeUpload()`, which start an upload, and that `refresh()`'s answer is the only place it shows.
- **Why:** review r13 E3. Spec 1.0 §1 defines `startError` as "the route's last start refused without a file row",
  and M12-H2 sets it from `start()` in `use-upload.ts`. `refresh()` is a read of the resumable list: `useResumable`
  has no route store (its route is optional and a list may span every route), and a read is not a start. Making it
  set `startError` would also show a list read's error on a page's upload input. A pick or a drop of the same page
  already surfaces the same wrong option there.
- **If wrong:** a page that renders only `useResumable` and no upload has to read `refresh()`'s answer, or the first
  read's result, to see the configuration error.
- **Status:** in force. `src/react/use-upload.test.ts` ("resolves INVALID_CONFIG from upload(), resume() and
  refresh()") already pins the answers; the reviewer's probe saw `startError` null and `onError` silent.
- **Visible in:** `docs/guide/react.md` (Set up).

### M12-R53: CI runs the React tests on React 18.3.1

- **Decision:** a CI job `react-18` runs `scripts/test-react-18.sh 18.3.1`: a copy of the package's `src` and
  `tsconfig.json` in `$RUNNER_TEMP/react-check` with its own install of `react` and `react-dom` 18.3.1 and the
  workspace's versions of `vitest`, `happy-dom`, `@testing-library/react` and `@testing-library/dom`, then
  `vitest run src/react.test.ts src/react/`. The copy is removed by a trap set before it is made, so the workspace's
  React 19 and `bun.lock` are never touched. The `<Activity>` row of `upload-store.test.ts` skips there with
  `ctx.skip("<Activity> needs React 19")`, a declared gap: React 18 has no `<Activity>`. The stability page's React
  row says React 18.3.1 is tested in its own job.
- **Why:** review r13 E5. `peerDependencies.react` is `>=18`, but `verify` and CI installed and tested 19.3.1 only, so
  nothing caught a React 18 regression. Run locally on 2026-11-22: 67 passed, 1 skipped (the `<Activity>` row), on
  react and react-dom 18.3.1; without the skip that row fails with "Element type is invalid ... got: undefined".
- **If wrong:** the job tests the runtime only, not the types against `@types/react` 18; the reviewer type-checked
  the source against 18.3.12 once (exit 0). A test that uses another React 19 API must skip the same way.
- **Status:** in force.
- **Visible in:** `.github/workflows/ci.yml` (`react-18`), `scripts/test-react-18.sh`,
  `src/react/upload-store.test.ts`, `docs/guide/stability.md`, `CONTRIBUTING.md`, `AGENTS.md`.

### M12-R54: a hook listens for ends from its commit, in a layout effect

- **Decision:** `useUpload` registers its `onEnd` listener in a layout effect in the browser, and in `useEffect`
  where there is no `document` (`useCommitEffect` in `src/react/use-upload.ts`). A hook that React committed hears
  every end of its route from then on. StrictMode's double effect still leaves one listener, `<Activity>` hiding
  still removes it, and the server runs neither. This amends M12-H1's "registers ... in a `useEffect`".
- **Why:** review r13 U1, confirmed by a probe on React 19.3.1 outside `act`. React runs a commit's passive effects in
  a later task; an end that lands between the commit and that task (in a browser, a network answer can) reached the
  route's other hooks but not the newly committed one: the probe's late hook heard `[]` while the keeper heard
  `INVALID_INPUT`. React 18's server renderer warns "useLayoutEffect does nothing on the server" (checked in
  `react-dom-server.node.development.js` 18.3.1), so the server keeps `useEffect`, which never runs there either.
- **If wrong:** a child's own layout effect runs before its parent's, so an end it causes synchronously is still not
  heard by a `useUpload` in the parent. `cloudrop/react` grows by a few bytes.
- **Status:** in force. `src/react/use-upload-callbacks.test.ts` ("calls a hook that has committed for an end before
  React runs its passive effects"): red before the fix, and red again with `useEffect` put back as a fault probe.
- **Visible in:** `src/react/use-upload.ts`, `src/react/use-upload-callbacks.test.ts`, `docs/guide/react.md` (Only
  while mounted), `docs/decisions/m12-hooks.md` (M12-H1).
