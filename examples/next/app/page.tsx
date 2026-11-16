"use client";

import { createCloudropClient } from "cloudrop/client";
import { type ChangeEvent, useState } from "react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "../lib/cloudrop";

const client = createCloudropClient<typeof cloudrop>();

export default function Page() {
  const [status, setStatus] = useState("");

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so that choosing the same file again uploads it: Chromium fires `cancel`, not `change`, for an unchanged
    // selection.
    event.target.value = "";
    if (!file) return;
    setStatus(`Uploading ${file.name}…`);
    const { data, error } = await client.upload("files", file);
    setStatus(
      error ? `${error.code}: ${error.message}` : `Uploaded ${file.name} (${file.size} bytes) as ${data.data.key}`,
    );
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: "40rem", margin: "2rem auto", lineHeight: 1.6 }}>
      <h1>cloudrop example</h1>
      {/* Demo only: a stand-in for a real sign-in, see app/api/demo-sign-in/route.ts. */}
      <form method="post" action="/api/demo-sign-in">
        <button type="submit">Sign in as the demo user</button>
      </form>
      <p>
        <label>
          File to upload <input type="file" onChange={onChange} />
        </label>
      </p>
      <p role="status">{status}</p>
    </main>
  );
}
