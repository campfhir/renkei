/**
 * TIFF, rewritten. A TIFF is a graph of offsets, which is exactly where
 * hostile files hide things, so this does not "clean" the input — it
 * reads the few tags that describe strips of pixels, checks every offset
 * and length against the file, and writes a new little-endian TIFF from
 * them alone. SubIFDs, EXIF/GPS directories, XMP, IPTC, ICC and
 * Photoshop blocks, tiles, JPEG-in-TIFF, BigTIFF and every tag not on the
 * list below are not carried over; trailing and unreferenced bytes
 * cannot survive because nothing is copied that was not named by a tag.
 */

import {
  BINARY_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_RAW_BYTES,
  IMAGE_MAX_SIDE,
  refuse,
  type BinaryCheck,
} from './types';

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

/** Bytes per element, and how wide the units are that a byte-swap reverses. */
const TYPE_SIZE: Record<number, { size: number; unit: number }> = {
  1: { size: 1, unit: 1 },
  3: { size: 2, unit: 2 },
  4: { size: 4, unit: 4 },
  5: { size: 8, unit: 4 },
  6: { size: 1, unit: 1 },
  7: { size: 1, unit: 1 },
  8: { size: 2, unit: 2 },
  9: { size: 4, unit: 4 },
  10: { size: 8, unit: 4 },
  11: { size: 4, unit: 4 },
  12: { size: 8, unit: 8 },
};

interface TagRule {
  types: number[];
  maxCount: number;
}

/** The only tags carried over, and the shapes each may take. */
const TAGS: Record<number, TagRule> = {
  254: { types: [LONG], maxCount: 1 }, // NewSubfileType
  255: { types: [SHORT], maxCount: 1 }, // SubfileType
  256: { types: [SHORT, LONG], maxCount: 1 }, // ImageWidth
  257: { types: [SHORT, LONG], maxCount: 1 }, // ImageLength
  258: { types: [SHORT], maxCount: 4 }, // BitsPerSample
  259: { types: [SHORT], maxCount: 1 }, // Compression
  262: { types: [SHORT], maxCount: 1 }, // PhotometricInterpretation
  266: { types: [SHORT], maxCount: 1 }, // FillOrder
  273: { types: [SHORT, LONG], maxCount: 65_536 }, // StripOffsets
  274: { types: [SHORT], maxCount: 1 }, // Orientation
  277: { types: [SHORT], maxCount: 1 }, // SamplesPerPixel
  278: { types: [SHORT, LONG], maxCount: 1 }, // RowsPerStrip
  279: { types: [SHORT, LONG], maxCount: 65_536 }, // StripByteCounts
  282: { types: [RATIONAL], maxCount: 1 }, // XResolution
  283: { types: [RATIONAL], maxCount: 1 }, // YResolution
  284: { types: [SHORT], maxCount: 1 }, // PlanarConfiguration
  296: { types: [SHORT], maxCount: 1 }, // ResolutionUnit
  317: { types: [SHORT], maxCount: 1 }, // Predictor
  320: { types: [SHORT], maxCount: 768 }, // ColorMap
  338: { types: [SHORT], maxCount: 4 }, // ExtraSamples
  339: { types: [SHORT], maxCount: 4 }, // SampleFormat
};

/** none, LZW, Deflate (both numberings), PackBits. */
const COMPRESSIONS = new Set([1, 5, 8, 32946, 32773]);
const MAX_PAGES = 16;
const MAX_ENTRIES = 256;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Values as little-endian element bytes. */
  value: Buffer;
}

interface Page {
  entries: Map<number, Entry>;
  strips: Buffer[];
}

export function sanitizeTiff(input: Buffer): BinaryCheck {
  if (input.length < 8) return refuse('This is not a TIFF: it is too short.');
  const order = input.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM')
    return refuse('This is not a TIFF: the byte-order mark is missing.');
  const le = order === 'II';
  const u16 = (o: number) => (le ? input.readUInt16LE(o) : input.readUInt16BE(o));
  const u32 = (o: number) => (le ? input.readUInt32LE(o) : input.readUInt32BE(o));
  const magic = u16(2);
  if (magic === 43) return refuse('BigTIFF is not accepted; write a standard TIFF.');
  if (magic !== 42) return refuse('This is not a TIFF: the version number is wrong.');

  const pages: Page[] = [];
  const seen = new Set<number>();
  let dropped = 0;
  let next = u32(4);
  while (next !== 0) {
    if (pages.length >= MAX_PAGES) return refuse(`The TIFF has more than ${MAX_PAGES} pages.`);
    if (seen.has(next)) return refuse('The TIFF directory chain loops back on itself.');
    seen.add(next);
    if (next < 8 || next + 2 > input.length)
      return refuse('A TIFF directory offset is out of range.');
    const count = u16(next);
    if (count < 1 || count > MAX_ENTRIES || next + 2 + count * 12 + 4 > input.length) {
      return refuse('A TIFF directory overruns the file.');
    }
    const entries = new Map<number, Entry>();
    for (let i = 0; i < count; i++) {
      const at = next + 2 + i * 12;
      const tag = u16(at);
      const rule = TAGS[tag];
      if (!rule) {
        dropped += 1;
        continue;
      }
      const type = u16(at + 2);
      const n = u32(at + 4);
      const info = TYPE_SIZE[type];
      if (!info || !rule.types.includes(type)) {
        return refuse(`TIFF tag ${tag} has a data type that is not valid for it.`);
      }
      if (n < 1 || n > rule.maxCount) return refuse(`TIFF tag ${tag} has an invalid value count.`);
      if (entries.has(tag)) return refuse(`TIFF tag ${tag} appears twice in one directory.`);
      const bytes = n * info.size;
      const valueAt = bytes <= 4 ? at + 8 : u32(at + 8);
      if (valueAt + bytes > input.length) return refuse(`TIFF tag ${tag} points outside the file.`);
      const value = Buffer.from(input.subarray(valueAt, valueAt + bytes));
      if (!le && info.unit > 1) {
        for (let o = 0; o < value.length; o += info.unit) {
          value.subarray(o, o + info.unit).reverse();
        }
      }
      entries.set(tag, { tag, type, count: n, value });
    }
    next = u32(next + 2 + count * 12);

    const page = checkPage(entries, input);
    if (typeof page === 'string') return refuse(page);
    pages.push(page);
  }
  if (pages.length === 0) return refuse('The TIFF has no image.');

  const bytes = write(pages);
  if (bytes.length > BINARY_MAX_BYTES * 4) return refuse('The TIFF is too large once rebuilt.');
  const notes: string[] = [];
  if (dropped > 0)
    notes.push(
      `${dropped} TIFF tag(s) beyond the pixel description (metadata, profiles) were removed.`
    );
  return { ok: true, bytes, mediaType: 'image/tiff', notes };

  function checkPage(e: Map<number, Entry>, file: Buffer): Page | string {
    const num = (tag: number, fallback: number): number => {
      const entry = e.get(tag);
      if (!entry) return fallback;
      return entry.type === SHORT ? entry.value.readUInt16LE(0) : entry.value.readUInt32LE(0);
    };
    const list = (tag: number): number[] =>
      e.get(tag)
        ? Array.from({ length: e.get(tag)!.count }, (_, i) =>
            e.get(tag)!.type === SHORT
              ? e.get(tag)!.value.readUInt16LE(2 * i)
              : e.get(tag)!.value.readUInt32LE(4 * i)
          )
        : [];

    const width = num(256, 0);
    const height = num(257, 0);
    if (width < 1 || height < 1 || width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
      return `The TIFF must be between 1 and ${IMAGE_MAX_SIDE} pixels on each side.`;
    }
    if (width * height > IMAGE_MAX_PIXELS)
      return `The TIFF covers more than ${IMAGE_MAX_PIXELS} pixels.`;
    const samples = num(277, 1);
    if (samples < 1 || samples > 4) return 'The TIFF must have 1 to 4 samples per pixel.';
    const bits = list(258);
    const perSample = bits.length ? bits : [1];
    if (perSample.length !== 1 && perSample.length !== samples) {
      return 'The TIFF BitsPerSample does not match SamplesPerPixel.';
    }
    if (perSample.some((b) => ![1, 2, 4, 8, 16].includes(b)) || new Set(perSample).size !== 1) {
      return 'The TIFF must use one bit depth of 1, 2, 4, 8 or 16 for every sample.';
    }
    const compression = num(259, 1);
    if (!COMPRESSIONS.has(compression)) {
      return 'The TIFF compression is not accepted (use none, LZW, Deflate or PackBits).';
    }
    const photometric = e.has(262) ? num(262, -1) : -1;
    if (![0, 1, 2, 3].includes(photometric)) {
      return 'The TIFF photometric interpretation must be greyscale (0/1), RGB (2) or palette (3).';
    }
    if (num(284, 1) !== 1) return 'Only chunky (PlanarConfiguration 1) TIFFs are accepted.';
    if (num(317, 1) > 2) return 'The TIFF predictor is not accepted.';
    if (photometric === 3) {
      const map = e.get(320);
      if (!map || map.count !== 3 * 2 ** perSample[0]!)
        return 'The palette TIFF has no matching ColorMap.';
    }
    if (photometric === 2 && samples < 3) return 'An RGB TIFF needs at least 3 samples per pixel.';

    const offsets = list(273);
    const counts = list(279);
    if (offsets.length === 0 || offsets.length !== counts.length) {
      return 'The TIFF needs matching StripOffsets and StripByteCounts (tiled TIFFs are not accepted).';
    }
    const rawBytes = height * Math.ceil((width * samples * perSample[0]!) / 8);
    if (rawBytes > IMAGE_MAX_RAW_BYTES)
      return 'The TIFF would expand to more pixel data than is allowed.';
    const rowsPerStrip = Math.min(num(278, height), height);
    if (rowsPerStrip < 1 || offsets.length !== Math.ceil(height / rowsPerStrip)) {
      return 'The TIFF strip count does not match its image height and RowsPerStrip.';
    }
    let total = 0;
    const strips: Buffer[] = [];
    for (let i = 0; i < offsets.length; i++) {
      const start = offsets[i]!;
      const length = counts[i]!;
      if (length < 1 || start + length > file.length)
        return 'A TIFF strip points outside the file.';
      total += length;
      if (total > BINARY_MAX_BYTES) return 'The TIFF strips are larger than the file allowance.';
      strips.push(file.subarray(start, start + length));
    }
    if (compression === 1 && total < rawBytes)
      return 'The uncompressed TIFF strips are shorter than the image needs.';
    return { entries: e, strips };
  }
}

/** Little-endian TIFF built from the checked pages and nothing else. */
function write(pages: Page[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  parts.push(header);
  let cursor = 8;
  const align = (n: number) => n + (n % 2);

  pages.forEach((page, index) => {
    const tags = [...page.entries.keys()].sort((a, b) => a - b);
    const tableSize = 2 + tags.length * 12 + 4;
    let valuesAt = cursor + tableSize;
    const pending: Array<{ at: number; data: Buffer }> = [];
    const table = Buffer.alloc(tableSize);
    table.writeUInt16LE(tags.length, 0);

    // Strip data sits after the out-of-line values; compute its position once the values are laid out.
    const stripBytes = page.strips.map((s) => align(s.length));
    const entryBuffers = new Map<number, { type: number; count: number; value: Buffer }>();
    for (const tag of tags) {
      const entry = page.entries.get(tag)!;
      if (tag === 273 || tag === 279) continue; // rebuilt below
      entryBuffers.set(tag, { type: entry.type, count: entry.count, value: entry.value });
    }
    entryBuffers.set(279, {
      type: LONG,
      count: page.strips.length,
      value: Buffer.concat(
        page.strips.map((s) => {
          const b = Buffer.alloc(4);
          b.writeUInt32LE(s.length, 0);
          return b;
        })
      ),
    });
    // Reserve 273's slot with a placeholder of the right size; fill once positions are known.
    entryBuffers.set(273, {
      type: LONG,
      count: page.strips.length,
      value: Buffer.alloc(4 * page.strips.length),
    });

    let outOfLine = 0;
    for (const e of entryBuffers.values())
      if (e.value.length > 4) outOfLine += align(e.value.length);
    const stripStart = valuesAt + outOfLine;
    const positions: number[] = [];
    let at = stripStart;
    for (const size of stripBytes) {
      positions.push(at);
      at += size;
    }
    const offsetsBuffer = Buffer.alloc(4 * positions.length);
    positions.forEach((p, i) => offsetsBuffer.writeUInt32LE(p, 4 * i));
    entryBuffers.set(273, { type: LONG, count: positions.length, value: offsetsBuffer });

    tags.forEach((tag, i) => {
      const e = entryBuffers.get(tag)!;
      const row = 2 + i * 12;
      table.writeUInt16LE(tag, row);
      table.writeUInt16LE(e.type, row + 2);
      table.writeUInt32LE(e.count, row + 4);
      if (e.value.length <= 4) {
        e.value.copy(table, row + 8);
      } else {
        table.writeUInt32LE(valuesAt, row + 8);
        pending.push({ at: valuesAt, data: e.value });
        valuesAt += align(e.value.length);
      }
    });
    const isLast = index === pages.length - 1;
    table.writeUInt32LE(isLast ? 0 : at, 2 + tags.length * 12);

    parts.push(table);
    for (const p of pending) parts.push(p.data, Buffer.alloc(p.data.length % 2));
    page.strips.forEach((s) => parts.push(s, Buffer.alloc(s.length % 2)));
    cursor = at;
  });
  return Buffer.concat(parts);
}
