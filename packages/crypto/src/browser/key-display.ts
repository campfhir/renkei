/**
 * A person's user key as they write it down (docs/delegate-key-design.md,
 * "The user key"): thirty-two random bytes, shown once as fourteen groups
 * of four lowercase base32 characters — fifty-two for the key, four for a
 * checksum — so a typo on another device is caught before anything is
 * tried with the wrong key.
 *
 *   abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567-abcd-efgh-ijkl-mnop-qrst-uvwx
 *
 * The alphabet is RFC 4648's (a–z, 2–7); parsing ignores case, spaces and
 * dashes. Pure, so the page that shows the key and the delegate that
 * never sees it share one definition.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const USER_KEY_BYTES = 32;
const KEY_CHARS = 52; // ceil(32 * 8 / 5)
const CHECKSUM_CHARS = 4;
const GROUP = 4;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string, byteLength: number): Uint8Array<ArrayBuffer> | null {
  const out = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index >= byteLength) return null;
      out[index] = (buffer >> bits) & 255;
      index += 1;
    }
  }
  return index === byteLength ? out : null;
}

/** The checksum: the top twenty bits of CRC-32 over the key, as four base32 characters. */
function checksumOf(bytes: Uint8Array): string {
  const crc = crc32(bytes);
  const top = crc >>> 12;
  return (
    ALPHABET[(top >> 15) & 31] +
    ALPHABET[(top >> 10) & 31] +
    ALPHABET[(top >> 5) & 31] +
    ALPHABET[top & 31]
  );
}

/** The key as the person writes it down. */
export function formatUserKey(bytes: Uint8Array): string {
  if (bytes.length !== USER_KEY_BYTES) throw new Error(`a user key is ${USER_KEY_BYTES} bytes`);
  const raw = toBase32(bytes) + checksumOf(bytes);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join('-');
}

export type UserKeyParseError = 'WRONG_LENGTH' | 'BAD_CHARACTER' | 'CHECKSUM';

/** The key as typed, forgiving case, spaces and dashes; the checksum catches a typo. */
export function parseUserKey(
  text: string
): { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; error: UserKeyParseError } {
  const clean = text.toLowerCase().replace(/[\s-]+/g, '');
  if (clean.length !== KEY_CHARS + CHECKSUM_CHARS) return { ok: false, error: 'WRONG_LENGTH' };
  for (const char of clean) {
    if (!ALPHABET.includes(char)) return { ok: false, error: 'BAD_CHARACTER' };
  }
  const bytes = fromBase32(clean.slice(0, KEY_CHARS), USER_KEY_BYTES);
  if (!bytes) return { ok: false, error: 'BAD_CHARACTER' };
  if (checksumOf(bytes) !== clean.slice(KEY_CHARS)) return { ok: false, error: 'CHECKSUM' };
  return { ok: true, bytes };
}

/**
 * A short code for a device's ephemeral public key, read aloud or
 * compared across two screens during device approval: the first six
 * base32 characters of the key, grouped in threes.
 */
export function deviceCodeOf(publicKey: Uint8Array): string {
  const chars = toBase32(publicKey).slice(0, 6).toUpperCase();
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}
