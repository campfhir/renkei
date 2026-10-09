/**
 * Byte encodings the browser and node halves of the key code share. Pure
 * functions over Uint8Array — no node:crypto, no Buffer — so the same
 * module runs in a page and in a worker.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Bytes over a plain ArrayBuffer — what WebCrypto's BufferSource accepts
 * under the DOM lib. Every function here returns this shape, and every
 * parameter takes it, so a page's and a worker's bytes are the same type.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** A copy of any byte view as plain bytes. */
export function toBytes(view: Uint8Array): Bytes {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[triple & 63] : '=';
  }
  return out;
}

export function base64ToBytes(text: string): Bytes | null {
  let clean = text.replace(/\s+/g, '');
  while (clean.endsWith('=')) clean = clean.slice(0, -1);
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export function utf8ToBytes(text: string): Bytes {
  return toBytes(new TextEncoder().encode(text));
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
