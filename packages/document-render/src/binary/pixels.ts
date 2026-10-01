/**
 * PNG ⇄ raw pixels, and resizing them — what an animation needs to work
 * with the frames an image model draws. Decoding goes through
 * `sanitizePng` first, so every limit and check the validator applies
 * (CRCs, sizes, decompression bombs, filter bytes) applies here too; what
 * is decoded is the rebuilt file, never the caller's bytes.
 *
 * Pixels are 8-bit RGBA, row by row, top to bottom: 16-bit samples keep
 * their high byte, low bit depths are scaled up, palettes and tRNS are
 * resolved.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { chunk, sanitizePng, SIGNATURE } from './png';

export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes: R, G, B, A. */
  data: Uint8Array;
}

export type PixelsResult = { ok: true; image: RgbaImage } | { ok: false; reason: string };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses one scanline's filter in place; `prev` is the row above, already unfiltered (or null). */
function unfilter(row: Uint8Array, prev: Uint8Array | null, filter: number, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp]! : 0;
    const up = prev ? prev[i]! : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp]! : 0;
    let add = 0;
    if (filter === 1) add = left;
    else if (filter === 2) add = up;
    else if (filter === 3) add = (left + up) >> 1;
    else if (filter === 4) add = paeth(left, up, upLeft);
    row[i] = (row[i]! + add) & 0xff;
  }
}

/** The PNG's pixels as 8-bit RGBA; the file is validated and rebuilt first. */
export function decodePng(input: Buffer): PixelsResult {
  const checked = sanitizePng(input);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  // The rebuilt file: IHDR, the kept ancillary chunks, one IDAT, IEND — all CRC-correct.
  const clean = checked.bytes;
  let ihdr: Buffer | null = null;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  let idat: Buffer | null = null;
  for (let pos = SIGNATURE.length; pos + 12 <= clean.length;) {
    const length = clean.readUInt32BE(pos);
    const type = clean.toString('latin1', pos + 4, pos + 8);
    const data = clean.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat = data;
    pos += 12 + length;
  }
  if (!ihdr || !idat) return { ok: false, reason: 'The PNG has no header or no pixel data.' };

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const colorType = ihdr[9]!;
  const interlaced = ihdr[12] === 1;
  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = inflateSync(idat);
  const out = new Uint8Array(width * height * 4);
  const maxSample = 2 ** depth - 1;

  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
    if (depth === 8) return row[index]!;
    const bit = index * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & maxSample;
  };
  const to8 = (value: number): number =>
    depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / maxSample);
  const trnsValue = (i: number) =>
    trns && trns.length >= i * 2 + 2 ? trns.readUInt16BE(i * 2) : -1;

  const put = (row: Uint8Array, column: number, x: number, y: number) => {
    const at = (y * width + x) * 4;
    const first = column * channels;
    if (colorType === 3) {
      const index = sample(row, first);
      out[at] = palette && index * 3 + 2 < palette.length ? palette[index * 3]! : 0;
      out[at + 1] = palette && index * 3 + 2 < palette.length ? palette[index * 3 + 1]! : 0;
      out[at + 2] = palette && index * 3 + 2 < palette.length ? palette[index * 3 + 2]! : 0;
      out[at + 3] = trns && index < trns.length ? trns[index]! : 255;
      return;
    }
    if (colorType === 0 || colorType === 4) {
      const grey = sample(row, first);
      const value = to8(grey);
      out[at] = value;
      out[at + 1] = value;
      out[at + 2] = value;
      out[at + 3] = colorType === 4 ? to8(sample(row, first + 1)) : grey === trnsValue(0) ? 0 : 255;
      return;
    }
    const r = sample(row, first);
    const g = sample(row, first + 1);
    const b = sample(row, first + 2);
    out[at] = to8(r);
    out[at + 1] = to8(g);
    out[at + 2] = to8(b);
    out[at + 3] =
      colorType === 6
        ? to8(sample(row, first + 3))
        : r === trnsValue(0) && g === trnsValue(1) && b === trnsValue(2)
          ? 0
          : 255;
  };

  const passes = interlaced ? ADAM7 : [{ x: 0, y: 0, dx: 1, dy: 1 }];
  let offset = 0;
  for (const pass of passes) {
    const passWidth = width > pass.x ? Math.ceil((width - pass.x) / pass.dx) : 0;
    const passHeight = height > pass.y ? Math.ceil((height - pass.y) / pass.dy) : 0;
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    let prev: Uint8Array | null = null;
    for (let j = 0; j < passHeight; j++) {
      const filter = raw[offset]!;
      const row = new Uint8Array(raw.subarray(offset + 1, offset + 1 + rowBytes));
      offset += 1 + rowBytes;
      unfilter(row, prev, filter, bpp);
      for (let i = 0; i < passWidth; i++) put(row, i, pass.x + i * pass.dx, pass.y + j * pass.dy);
      prev = row;
    }
  }
  return { ok: true, image: { width, height, data: out } };
}

/** 8-bit RGBA pixels as a PNG we wrote ourselves: nothing in it but the pixels. */
export function encodePng({ width, height, data }: RgbaImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The largest size of this shape that fits within `maxSide` on both sides (never larger than it was). */
export function fitWithin(
  { width, height }: { width: number; height: number },
  maxSide: number
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The image at another size. Shrinking averages every source pixel a
 * target pixel covers (a box filter, so detail is not aliased away);
 * growing repeats the nearest one.
 */
export function resizeRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) {
    return { width, height, data: new Uint8Array(image.data) };
  }
  const out = new Uint8Array(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * image.width + sx) * 4;
          r += image.data[at]!;
          g += image.data[at + 1]!;
          b += image.data[at + 2]!;
          a += image.data[at + 3]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
      out[to + 3] = Math.round(a / count);
    }
  }
  return { width, height, data: out };
}

/**
 * The image filling `width` × `height` exactly: the middle of it cropped to
 * that shape, then resized — so a picture drawn in another shape is trimmed,
 * not stretched.
 */
export function coverRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  const wanted = width / height;
  let cropWidth = image.width;
  let cropHeight = image.height;
  if (image.width / image.height > wanted)
    cropWidth = Math.max(1, Math.round(image.height * wanted));
  else cropHeight = Math.max(1, Math.round(image.width / wanted));
  if (cropWidth === image.width && cropHeight === image.height) {
    return resizeRgba(image, width, height);
  }
  const left = Math.floor((image.width - cropWidth) / 2);
  const top = Math.floor((image.height - cropHeight) / 2);
  const data = new Uint8Array(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const from = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + cropWidth * 4), y * cropWidth * 4);
  }
  return resizeRgba({ width: cropWidth, height: cropHeight, data }, width, height);
}
