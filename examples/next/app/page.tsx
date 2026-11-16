"use client";

import { createCloudropClient } from "cloudrop/client";
import { type ChangeEvent, useState } from "react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "../lib/cloudrop";

const client = createCloudropClient<typeof cloudrop>();

/** Demo only: a stand-in for a real sign-in, read by `authorize` in lib/cloudrop.ts. */
function signIn() {
  // biome-ignore lint/suspicious/noDocumentCookie: one fixed cookie; the Cookie Store API is async and newer than the demo needs.
  document.cookie = "demo-user=demo; path=/; SameSite=Lax";
}

export default function Page() {
  const [status, setStatus] = useState("");

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const { data, error } = await client.upload("files", file);
    setStatus(
      error ? `${error.code}: ${error.message}` : `Uploaded ${file.name} (${file.size} bytes) as ${data.data.key}`,
    );
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: "40rem", margin: "2rem auto", lineHeight: 1.6 }}>
      <h1>cloudrop example</h1>
      <p>
        <button type="button" onClick={signIn}>
          Sign in as the demo user
        </button>
      </p>
      <p>
        <label>
          File to upload <input type="file" onChange={onChange} />
        </label>
      </p>
      <p role="status">{status}</p>
    </main>
  );
}
