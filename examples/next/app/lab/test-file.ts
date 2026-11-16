/** The most bytes crypto.getRandomValues fills in one call. */
const CHUNK_BYTES = 65_536;

export const TEST_FILE_SIZES = [
  { label: "1 KiB", bytes: 1024 },
  { label: "5 MiB", bytes: 5 * 1024 * 1024 },
  { label: "20 MiB", bytes: 20 * 1024 * 1024 },
  { label: "100 MiB", bytes: 100 * 1024 * 1024 },
] as const;

/** A file of random bytes made in the browser, so no test file has to be on disk. */
export function randomFile(label: string, bytes: number): File {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < bytes; offset += CHUNK_BYTES) {
    chunks.push(crypto.getRandomValues(new Uint8Array(Math.min(CHUNK_BYTES, bytes - offset))));
  }
  return new File(chunks, `random-${label.replace(" ", "-")}.bin`, { type: "application/octet-stream" });
}
