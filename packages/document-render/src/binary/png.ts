/**
 * PNG, rebuilt. The input is parsed chunk by chunk with every CRC checked;
 * only the chunks that describe pixels survive (IHDR, PLTE, tRNS, the
 * colour-space hints, IDAT, IEND). Text, EXIF, ICC profiles, APNG frames,
 * private chunks and anything after IEND are dropped, so nothing smuggled
 * beside the pixels reaches the person. The pixel stream is inflated
 * (bounded — a decompression bomb is refused), checked against the size
 * the header promises, its filter bytes verified, and re-deflated by our
 * own zlib, so the compressed stream in the output is one we made.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import {
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_RAW_BYTES,
  IMAGE_MAX_SIDE,
  refuse,
  type BinaryCheck,
} from './types';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ancillary chunks that only describe how to read the pixels. */
const KEPT_ANCILLARY = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs']);

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, tail]);
}

const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
];

/** Groups of identical scanlines in stream order: [rows, bytes per row incl. filter byte]. */
function scanlineGroups(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlaced: boolean
): Array<[number, number]> {
  const rowBytes = (w: number) => 1 + Math.ceil((w * bitsPerPixel) / 8);
  if (!interlaced) return [[height, rowBytes(width)]];
  const groups: Array<[number, number]> = [];
  for (const pass of ADAM7) {
    const w = width > pass.x ? Math.ceil((width - pass.x) / pass.dx) : 0;
    const h = height > pass.y ? Math.ceil((height - pass.y) / pass.dy) : 0;
    if (w > 0 && h > 0) groups.push([h, rowBytes(w)]);
  }
  return groups;
}

export function sanitizePng(input: Buffer): BinaryCheck {
  if (input.length < 8 || !input.subarray(0, 8).equals(SIGNATURE)) {
    return refuse('This is not a PNG: the 8-byte PNG signature is missing.');
  }
  let pos = 8;
  let ihdr: Buffer | null = null;
  let sawIend = false;
  let sawIdat = false;
  let idatEnded = false;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  const kept: Array<{ type: string; data: Buffer }> = [];
  let dropped = 0;

  while (pos < input.length && !sawIend) {
    if (pos + 12 > input.length) return refuse('The PNG is truncated inside a chunk header.');
    const length = input.readUInt32BE(pos);
    const type = input.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return refuse('The PNG has a chunk with an invalid type.');
    if (length > input.length - pos - 12) return refuse(`The PNG chunk ${type} overruns the file.`);
    const data = input.subarray(pos + 8, pos + 8 + length);
    const stored = input.readUInt32BE(pos + 8 + length);
    if (crc32(input.subarray(pos + 4, pos + 8), data) !== stored) {
      return refuse(`The PNG chunk ${type} fails its CRC check; the bytes are corrupt.`);
    }
    pos += 12 + length;

    if (!ihdr) {
      if (type !== 'IHDR' || length !== 13)
        return refuse('The first PNG chunk must be a 13-byte IHDR.');
      ihdr = data;
      continue;
    }
    if (type === 'IHDR') return refuse('The PNG has more than one IHDR.');
    if (type === 'IEND') {
      if (length !== 0) return refuse('The PNG IEND chunk must be empty.');
      sawIend = true;
    } else if (type === 'IDAT') {
      if (idatEnded) return refuse('The PNG IDAT chunks are not consecutive.');
      sawIdat = true;
      idat.push(data);
    } else {
      if (sawIdat) idatEnded = true;
      if (type === 'PLTE') {
        if (sawIdat) return refuse('The PNG PLTE chunk comes after the pixel data.');
        if (palette) return refuse('The PNG has more than one PLTE.');
        if (length === 0 || length % 3 !== 0 || length > 768) {
          return refuse('The PNG palette has an invalid length.');
        }
        palette = data;
        kept.push({ type, data });
      } else if (KEPT_ANCILLARY.has(type)) {
        kept.push({ type, data });
      } else {
        dropped += 1;
      }
    }
  }
  if (!ihdr) return refuse('The PNG has no IHDR chunk.');
  if (!sawIend) return refuse('The PNG ends without an IEND chunk (truncated).');
  if (!sawIdat) return refuse('The PNG has no pixel data (IDAT).');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const colorType = ihdr[9]!;
  const interlace = ihdr[12]!;
  if (ihdr[10] !== 0 || ihdr[11] !== 0)
    return refuse('The PNG uses an unknown compression or filter method.');
  if (interlace > 1) return refuse('The PNG uses an unknown interlace method.');
  if (!DEPTHS[colorType]?.includes(depth)) {
    return refuse(`The PNG colour type ${colorType} cannot have a bit depth of ${depth}.`);
  }
  if (width < 1 || height < 1 || width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    return refuse(`The PNG must be between 1 and ${IMAGE_MAX_SIDE} pixels on each side.`);
  }
  if (width * height > IMAGE_MAX_PIXELS) {
    return refuse(`The PNG covers more than ${IMAGE_MAX_PIXELS} pixels.`);
  }
  if (colorType === 3 && !palette) return refuse('The PNG is palette-based but has no PLTE.');
  if (palette && (colorType === 0 || colorType === 4)) {
    return refuse('A greyscale PNG must not carry a palette.');
  }
  if (palette && palette.length / 3 > 2 ** depth && colorType === 3) {
    return refuse('The PNG palette has more entries than its bit depth allows.');
  }

  const groups = scanlineGroups(width, height, CHANNELS[colorType]! * depth, interlace === 1);
  const expected = groups.reduce((sum, [rows, bytes]) => sum + rows * bytes, 0);
  if (expected > IMAGE_MAX_RAW_BYTES) {
    return refuse('The PNG would expand to more raw pixel data than is allowed.');
  }

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    return refuse(
      'The PNG pixel data is not a valid zlib stream, or expands beyond what its header declares.'
    );
  }
  if (raw.length !== expected) {
    return refuse('The PNG pixel data does not match the size its header declares.');
  }
  let offset = 0;
  for (const [rows, bytes] of groups) {
    for (let r = 0; r < rows; r++, offset += bytes) {
      if (raw[offset]! > 4) return refuse('The PNG pixel data has an invalid scanline filter.');
    }
  }

  const out = [SIGNATURE, chunk('IHDR', ihdr)];
  // Keep the original order, except that PLTE must precede tRNS/bKGD, which it already does in valid files.
  for (const { type, data } of kept) out.push(chunk(type, data));
  out.push(chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));

  const notes: string[] = [];
  if (dropped > 0)
    notes.push(`${dropped} non-pixel PNG chunk(s) (metadata, text, extras) were removed.`);
  if (pos < input.length) notes.push('Bytes after the end of the PNG were removed.');
  return { ok: true, bytes: Buffer.concat(out), mediaType: 'image/png', notes };
}
