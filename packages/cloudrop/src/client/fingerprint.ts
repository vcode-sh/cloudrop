// Whether a picked file is the one an unfinished upload started with (spec §3.3). A heuristic: an edit between the
// edges, with the same size and timestamp, is not seen.

const EDGE = 64 * 1024;

/**
 * Hex SHA-256 of the first 64 KiB then the last 64 KiB (the whole file up to 128 KiB); "" without crypto.subtle.
 * Rejects only when the browser can no longer read the file.
 */
export async function fingerprintOf(file: File): Promise<string> {
  // Missing on a page served over plain HTTP from a LAN address: matching then rests on the other facts.
  if (!globalThis.crypto?.subtle) return "";
  const edges = file.size <= 2 * EDGE ? file : new Blob([file.slice(0, EDGE), file.slice(-EDGE)]);
  const digest = await crypto.subtle.digest("SHA-256", await edges.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `file` is the record's file: name, size, lastModified, type and fingerprint equal (spec §3.3). */
export async function isSameFile(
  record: { name: string; size: number; type: string; lastModified: number; fingerprint: string },
  file: File,
): Promise<boolean> {
  try {
    return (
      file.name === record.name &&
      file.size === record.size &&
      file.type === record.type &&
      file.lastModified === record.lastModified &&
      (await fingerprintOf(file)) === record.fingerprint
    );
  } catch {
    // A browser refuses to read a picked file that changed on disk since: it is no longer the upload's file.
    return false;
  }
}
