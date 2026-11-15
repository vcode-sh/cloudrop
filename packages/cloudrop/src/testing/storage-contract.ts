/** Test bytes in which each 4-byte word holds its own offset, big-endian: no two words repeat within 4 GiB. */
export function offsetBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  for (let offset = 0; offset + 4 <= length; offset += 4) view.setUint32(offset, offset);
  return out;
}
