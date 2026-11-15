// CRC32C (Castagnoli), the per-part checksum R2 validates when it is a signed header (spike Q5). It runs over every
// uploaded byte, so it uses slicing-by-8 with tables built at load time (8 KiB of memory, no table literal in the
// bundle). Measured on Node 26, 64 MiB buffer, median of 5: plain `for...of` + `?? 0` 150 MiB/s, indexed byte loop
// 659 MiB/s, this slicing-by-8 2172 MiB/s (about 18 times a 1 Gbps uplink). Spec §11.1 gates WebAssembly behind a
// benchmark; this clears the bar without it.

const POLYNOMIAL = 0x82f63b78;

// TABLES[k * 256 + b] is the CRC of byte `b` followed by `k` zero bytes; row 0 is the classic byte-at-a-time table.
const TABLES: Uint32Array = (() => {
  const tables = new Uint32Array(8 * 256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ POLYNOMIAL : value >>> 1;
    tables[index] = value >>> 0;
  }
  for (let index = 0; index < 256; index++) {
    let value = tables[index] as number;
    for (let row = 1; row < 8; row++) {
      value = (tables[value & 0xff] as number) ^ (value >>> 8);
      tables[row * 256 + index] = value >>> 0;
    }
  }
  return tables;
})();

/** CRC32C of `bytes`. Pass the previous result as `previous` to continue a checksum across chunks. */
export function crc32c(bytes: Uint8Array, previous = 0): number {
  // `as number` below: every index is in bounds by construction, and `?? 0` cost 4x in this loop (measured).
  let crc = ~previous >>> 0;
  let index = 0;
  const blockEnd = bytes.length - 8;
  for (; index <= blockEnd; index += 8) {
    const low =
      crc ^
      (bytes[index] as number) ^
      ((bytes[index + 1] as number) << 8) ^
      ((bytes[index + 2] as number) << 16) ^
      ((bytes[index + 3] as number) << 24);
    crc =
      ((TABLES[1792 + (low & 0xff)] as number) ^
        (TABLES[1536 + ((low >>> 8) & 0xff)] as number) ^
        (TABLES[1280 + ((low >>> 16) & 0xff)] as number) ^
        (TABLES[1024 + (low >>> 24)] as number) ^
        (TABLES[768 + (bytes[index + 4] as number)] as number) ^
        (TABLES[512 + (bytes[index + 5] as number)] as number) ^
        (TABLES[256 + (bytes[index + 6] as number)] as number) ^
        (TABLES[bytes[index + 7] as number] as number)) >>>
      0;
  }
  for (; index < bytes.length; index++) {
    crc = (TABLES[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/** The `x-amz-checksum-crc32c` header value: base64 of the big-endian CRC32C. `btoa` is a web-platform global (no
 * `Buffer`), and four binary characters are all it ever sees. */
export function crc32cBase64(bytes: Uint8Array): string {
  const value = crc32c(bytes);
  return btoa(String.fromCharCode(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff));
}
