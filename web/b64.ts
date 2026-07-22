// Chunked base64 codec for arbitrary-length byte buffers. Kept dependency-
// free (no DOM beyond btoa/atob, which Node also provides globally) so it's
// directly testable from plain Node — see test/state-smoke.mjs.
//
// Why chunked: `String.fromCharCode(...bytes)` spreads the whole array as
// call arguments, which blows the engine's argument-count limit for large
// buffers (a save-state blob is ~86KB). Encoding in fixed-size chunks keeps
// each spread small. The chunk size (8193 = 2731*3) is a multiple of 3 bytes
// so every chunk's base64 encoding (aside from the very last, which may be
// short) is a whole number of 4-char groups with no interior '=' padding;
// that means naively concatenating each chunk's `btoa()` output equals the
// base64 encoding of the *entire* buffer in one pass, so decoding is a
// single plain `atob()` call — no need to remember chunk boundaries.
const CHUNK_BYTES = 8193;

export function b64EncodeChunked(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    const chunk = bytes.subarray(i, i + CHUNK_BYTES);
    out += btoa(String.fromCharCode(...chunk));
  }
  return out;
}

export function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
