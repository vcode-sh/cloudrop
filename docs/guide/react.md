# React

`cloudrop/react` turns the browser client into two hooks: `useUpload` for a file input, a drop zone and a list of files
with progress and controls, and `useResumable` for continuing large uploads after a reload. They are a thin layer over
[`cloudrop/client`](client.md): every upload is a client job, and the hooks only render it.

This page covers setup, a one-file input, a list of several files with progress and controls, drag and drop, resume
after a reload, what each hook returns, and how the hooks behave under server rendering, StrictMode and unmounting.

## Set up

React 18 or 19 is required; `react` is an optional peer dependency of `cloudrop`, needed only by this entry. Create the
hooks once, in a module of their own:

```ts
// lib/upload.ts
import { createUploadHooks } from "cloudrop/react";
import type { cloudrop } from "./cloudrop"; // a type import: no server code or secret reaches the browser

export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>();
```

Import `lib/upload.ts` only from `"use client"` modules. A Server Component that imports it pulls `cloudrop/react` into
the server's module graph, where React exports no `useState` or `useSyncExternalStore`, and the build fails.

`createUploadHooks` takes the [client's options](client.md#create-a-client) (`basePath`, `concurrency`, `namespace`
and the rest), or `{ client }` to share a client you already created for the same server's type. With options, the
client is created at the first upload or the first `useResumable` read in the browser, never while a server renders
the page. A wrong option never throws from your code: `upload()`, `resume()` and `refresh()` resolve
`{ data: null, error }` with its `INVALID_CONFIG` error, and a pick or a drop, which has no caller to resolve to, throws
it in a separate task, so it reaches the console and your error reporting.

The type argument gives the hooks your route names, each route's metadata and what each route's `onComplete` returns.
`useUpload("avatar")` knows the rest from the route name.

The hooks keep their uploads in the factory, one list per route. Every `useUpload("documents")` of these hooks shows the
same files, and a component that unmounts and mounts again, after a navigation or when a dialog closes and opens again,
finds its running and failed files there, and a failed file's `retry()` still sends it. That is why the factory is
created once, at module level: a factory created inside a component would start an empty list on every mount.

## One file

```tsx
"use client";
import { useUpload } from "../lib/upload";

export function AvatarPicker() {
  const { files, getInputProps } = useUpload("avatar", { accept: "image/*" });
  const avatar = files.at(-1);
  return (
    <label>
      Avatar <input {...getInputProps()} />
      {avatar?.status === "uploading" && <progress value={avatar.progress} />}
      {avatar?.error && <p role="alert">{avatar.error.message}</p>}
      {avatar?.result && <p>Saved as {avatar.result.file.key}</p>}
    </label>
  );
}
```

`getInputProps()` gives the input `type="file"`, `multiple`, `accept` and an `onChange` that uploads the picked files.
It then clears the input, so picking the same file again uploads it again: a browser fires no `change` for an
unchanged selection.

`accept` only filters the file picker. The route's own `accept` decides on the server, and a file it refuses ends
`failed` with `FILE_TYPE_NOT_ALLOWED`.

## Several files, with progress and controls

```tsx
"use client";
import { useUpload } from "../lib/upload";

export function DocumentUploader({ folderId }: { folderId: string }) {
  const { files, totals, isUploading, getInputProps, pause, resume, abort, clear } = useUpload("documents", {
    metadata: { folderId },
    multiple: true,
  });
  return (
    <section>
      <input {...getInputProps()} aria-label="Documents" />
      <progress value={totals.progress} />
      <button type="button" onClick={pause} disabled={!isUploading}>Pause all</button>
      <button type="button" onClick={() => resume()}>Resume all</button>
      <button type="button" onClick={abort}>Cancel all</button>
      <button type="button" onClick={clear}>Clear finished</button>
      <ul>
        {files.map((file) => (
          <li key={file.id}>
            {file.name}: {file.status} {Math.round(file.progress * 100)}%
            {file.status === "uploading" && <button type="button" onClick={file.pause}>Pause</button>}
            {file.status === "paused" && <button type="button" onClick={file.resume}>Resume</button>}
            {file.status === "failed" && <button type="button" onClick={() => file.retry()}>Retry</button>}
            {file.error && <span role="alert"> {file.error.message}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- `files` holds every file of the uploads started on this route through these hooks, from any component, in start
  order. Each is the client's
  [file snapshot](client.md#snapshots-and-react) (`status`, `bytes`, `progress`, `speed`, `eta`, `error`, `result`)
  with that file's `pause`, `resume`, `abort` and `retry`. A file's object changes only when that file changes, so a
  `memo` row renders again only for its own file.
- `totals` adds the uploads up as a job's totals do: failed and cancelled files are left out of the bytes, so they
  never hold the bar below 1.
- `metadata` is read from the latest render: when `folderId` changes, the next upload sends the new one. It is required
  when the route's schema requires it, and TypeScript says so.
- `clear()` removes the uploads whose every file ended done or cancelled, for every component on the route. An upload
  with a running or failed file stays: a failed file can still be retried, and the client keeps what it needs for that.
  Until `clear()` or a reload, the hooks keep every upload with its `File`, so call `clear()` after a page that pastes
  or drops many large files is done with them.
- `pause()`, `resume()`, `abort()` and `retry()` act on every file in `files`, so on the route's uploads that another
  component started too.

## Drag and drop

```tsx
"use client";
import { useUpload } from "../lib/upload";

export function DropZone() {
  const { files, isDragOver, getDropProps, getInputProps } = useUpload("documents", {
    metadata: { folderId: "inbox" },
    multiple: true,
  });
  return (
    <div {...getDropProps()} style={{ outline: isDragOver ? "2px dashed" : "none", padding: "2rem" }}>
      <p>Drop files here, or <input {...getInputProps()} aria-label="Choose files" /></p>
      <p>{files.length} files</p>
    </div>
  );
}
```

`getDropProps()` works on any element. `isDragOver` stays true while the drag crosses the element's children and turns
false when it leaves or drops. A hook without `multiple` uploads only the first dropped file, as its input takes one.
Only drags that carry files count: dragged text or a link keeps the browser's own behaviour, such as dropping text
into an input inside the zone.

## Start uploads yourself

`upload(files, { metadata })` starts one upload and resolves with its
[`UploadResult`](client.md#jobs-progress-pause-and-retry) once every file has first settled. It takes a `File`, an array
or a `FileList`, checked as the client checks them: anything that is not a `File` of this page, such as one from
another frame, resolves `INVALID_INPUT`. `null` or an empty list resolves `null` and starts nothing. The call's
metadata replaces the hook's.

```tsx
"use client";
import { useUpload } from "../lib/upload";

export function PasteTarget() {
  const { upload } = useUpload("documents", { metadata: { folderId: "inbox" } });
  return (
    <textarea
      aria-label="Paste files here"
      onPaste={async (event) => {
        const result = await upload(event.clipboardData.files);
        if (result?.error) console.warn(result.error.message);
      }}
    />
  );
}
```

`upload`, `pause`, `resume`, `abort`, `retry`, `clear` and `getDropProps` keep their identity across renders, and
`getInputProps` keeps it while `multiple` and `accept` stay the same, so an effect that lists one of them in its
dependencies does not run again on every render.

## Resume after a reload

```tsx
"use client";
import { useResumable, useUpload } from "../lib/upload";

export function Unfinished() {
  const { uploads } = useResumable("documents");
  const { files, resume, clear } = useUpload("documents", { metadata: { folderId: "inbox" } });
  return (
    <ul>
      {uploads.map((upload) => (
        <li key={upload.id}>
          {upload.name} was not finished. Pick it again to continue:{" "}
          <input
            type="file"
            aria-label={`Pick ${upload.name} again`}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void resume(upload, file);
            }}
          />
        </li>
      ))}
      {files.map((file) => (
        <li key={file.id}>
          {file.name}: {Math.round(file.progress * 100)}%
          {file.status === "failed" && (
            <>
              <span role="alert"> {file.error?.message}</span>
              <button type="button" onClick={() => file.retry()}>Retry</button>
              <button type="button" onClick={() => { file.abort(); clear(); }}>Dismiss</button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
```

`useResumable(route?)` returns `{ uploads, refresh }`: the client's `resumable()` list, of one route or of every route,
newest first. It leaves out the uploads this page holds: a file that is running, paused, or failed and kept for
`retry()`, and an upload while its resume runs. A failed file is continued with `files[n].retry()`, never `resume()`,
which would be refused. A listed upload leaves the list as soon as its resume starts.

A refused resume, `UPLOAD_IN_USE` while another tab sends the upload or `INVALID_INPUT` for a different file, stays in
`files` as a failed file with its error, and the upload is listed again: `retry()` checks again, and `abort()` ends the
row without touching the upload, which stays listed. Dismiss on a file that had already started, a resume that passed
its checks or a new upload, discards the upload: `abort()` tells the server to delete what it sent, unless a
`/complete` may have finished it.

The list is read after mount, when an upload of these hooks starts, whenever one of its files ends or starts again, and
when it settles, so a record the client deletes, for a file that ends done or is cancelled, leaves the list at once.
`refresh()` reads it again and resolves with the client's `Result`, whose `error` says why the list is empty. `uploads`
is `[]` on the server, before the first read and when the read failed. An upload started on a shared client directly,
not through the hooks, is not followed: call `refresh()` after it.

`resume(upload, file)` continues a record with the file the user picked again, as one more upload in the hook's
`files`, which every component on the hook's route shows. A browser never gives a page a file back after a reload, so
the user has to pick it. What counts as the same file, and what the server is asked first:
[Resume after reload](resume.md).

## What the hooks return

`useUpload(route, options?)`. Options: `metadata`, `multiple` (default `false`), `accept`.

| Field | What it is |
| --- | --- |
| `files` | Every file of the route's uploads, in start order, with its own `pause`, `resume`, `abort` and `retry`. |
| `totals` | `bytes`, `size`, `progress`, `speed`, `eta`, `done`, `failed`, `aborted` and `count` across those uploads. |
| `isUploading` | True while a file is queued, uploading or completing. A paused file is not uploading. |
| `isDragOver` | True while files are dragged over the element that has `getDropProps()`. |
| `upload(files, { metadata }?)` | Starts one upload; resolves with its `UploadResult`, or `null` for no file. |
| `getInputProps()` | `type`, `multiple`, `accept` and `onChange` for an `<input>`. |
| `getDropProps()` | `onDragEnter`, `onDragOver`, `onDragLeave` and `onDrop` for any element. |
| `pause()`, `resume()`, `abort()` | Pause, resume or cancel every file in `files`, as each file's own control does. |
| `retry()` | Sends every failed file again; resolves once they have settled. |
| `resume(upload, file)` | Continues a record from `useResumable`; resolves with its `UploadResult`. |
| `clear()` | Removes the uploads whose every file ended done or cancelled, for every component on the route. |

`useResumable(route?)`: `uploads` and `refresh()`, described above.

## Server rendering, StrictMode and unmounting

- **Server rendering.** React Server Components and server rendering load a `"use client"` module too. The hooks read a
  constant empty state there (no files, zero totals, no resumable uploads) and never create the client, so nothing
  touches `fetch`, IndexedDB or the page's lifecycle on the server, and the first browser render matches.
- **StrictMode.** No upload starts in an effect or during render, only in `upload()`, the input's `onChange`, a drop
  and `resume()`. StrictMode's second render and second effect start nothing; `useResumable` only reads once more.
- **Unmounting.** A component that unmounts stops listening and cancels nothing. The client owns its uploads: they
  finish, and a multipart upload's resume record stays. The route's list stays in the factory, so the next component
  on the route shows those uploads and can retry a failed file; until the page reloads, `useResumable` does not list
  them, because this page still holds them. Cancel on unmount yourself when that is what you want:
  `useEffect(() => abort, [abort])`, which cancels every upload of the route, including other components'. Under
  React 19's `<Activity mode="hidden">` that effect's cleanup runs too, so hiding counts as unmounting; without it, a
  hidden component shows what its uploads did once it is visible again.

## Types

The hooks infer everything from the route name: `useUpload("avatar")` has `files[n].result` typed by the avatar route's
`onComplete`, and `metadata` typed by its schema, required when the schema requires it. A record from
`useResumable("documents")` resumes only into a `documents` hook; records of every route narrow by `upload.route`.

For a component that takes a file as a prop, `UploadItem<R>` is the type of one `files` entry, where `R` is the route's
result type: `UploadItem<RouteResult<typeof cloudrop, "documents">>`, with `RouteResult` from `cloudrop/client`. The
other types (`UploadHooks`, `UseUploadOptions`, `UseUploadResult`, `UseResumableResult`, `InputProps`, `DropProps`,
`UploadHooksOptions`) are exported from `cloudrop/react` too. `{ client }` takes only a client created for a server with
the same route names: `createCloudropClient<typeof cloudrop>()`.
