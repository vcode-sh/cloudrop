"use client";

import type { UploadFile } from "cloudrop/react";
import { useUpload } from "../lib/upload";

/** The status line of the latest upload; the route's onComplete returns `{ key }`. */
function statusOf(file: UploadFile<{ key: string }>): string {
  if (file.error) return `${file.error.code}: ${file.error.message}`;
  if (file.result) return `Uploaded ${file.name} (${file.size} bytes) as ${file.result.data.key}`;
  return `Uploading ${file.name}…`;
}

export default function Page() {
  // getInputProps() clears the input after each pick, so choosing the same file again uploads it again.
  const { files, getInputProps } = useUpload("files");
  const latest = files.at(-1);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: "40rem", margin: "2rem auto", lineHeight: 1.6 }}>
      <h1>cloudrop example</h1>
      {/* Demo only: a stand-in for a real sign-in, see app/api/demo-sign-in/route.ts. */}
      <form method="post" action="/api/demo-sign-in">
        <button type="submit">Sign in as the demo user</button>
      </form>
      <p>
        <label>
          File to upload <input {...getInputProps()} />
        </label>
      </p>
      {latest && <progress value={latest.progress} aria-label={`${latest.name} progress`} />}
      <p role="status">{latest ? statusOf(latest) : ""}</p>
    </main>
  );
}
