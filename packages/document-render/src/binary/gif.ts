/**
 * Frames → an animated GIF, written here from pixels (GIF89a, looping).
 * Nothing of any input file survives into it: the frames are raw RGBA
 * (pixels.ts), quantized to one shared 256-colour palette — shared so a
 * colour does not shimmer from frame to frame — and LZW-compressed by our
 * own encoder. Transparency is flattened onto white: a GIF's one-bit
 * transparency would fringe every soft edge.
 */

import type { RgbaImage } from './pixels';

export interface GifOptions {
  /** How long each frame shows, in milliseconds (GIF counts in hundredths of a second). */
  delayMs: number;
}

/** The most frames any one GIF may have: a guard on memory, not a creative limit. */
export const GIF_MAX_FRAMES = 64;
const PALETTE_SIZE = 256;
/** Pixels sampled to choose the palette; more is slower without being better. */
const PALETTE_SAMPLES = 200_000;

/** An RGB triple, alpha flattened onto white. */
function flatten(data: Uint8Array, at: number): [number, number, number] {
  const alpha = data[at + 3]! / 255;
  const over = (value: number) => Math.round(value * alpha + 255 * (1 - alpha));
  return [over(data[at]!), over(data[at + 1]!), over(data[at + 2]!)];
}

/** Median cut: split the box of colours with the widest channel at its median until there are enough. */
function medianCut(samples: Uint8Array, wanted: number): Uint8Array {
  type Box = { colors: number[]; range: number; channel: number };
  const describe = (colors: number[]): Box => {
    let channel = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      let low = 255;
      let high = 0;
      for (const index of colors) {
        const value = samples[index * 3 + c]!;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      if (high - low > range) {
        range = high - low;
        channel = c;
      }
    }
    return { colors, range, channel };
  };
  const count = samples.length / 3;
  const boxes: Box[] = [describe(Array.from({ length: count }, (_, i) => i))];
  while (boxes.length < wanted) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.colors.length < 2 || box.range === 0) continue;
      if (
        pick === -1 ||
        box.range * box.colors.length > boxes[pick]!.range * boxes[pick]!.colors.length
      ) {
        pick = i;
      }
    }
    if (pick === -1) break;
    const { colors, channel } = boxes[pick]!;
    colors.sort((a, b) => samples[a * 3 + channel]! - samples[b * 3 + channel]!);
    const middle = colors.length >> 1;
    boxes.splice(pick, 1, describe(colors.slice(0, middle)), describe(colors.slice(middle)));
  }
  const palette = new Uint8Array(PALETTE_SIZE * 3);
  boxes.forEach((box, i) => {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (const index of box.colors) sum += samples[index * 3 + c]!;
      palette[i * 3 + c] = box.colors.length ? Math.round(sum / box.colors.length) : 0;
    }
  });
  return palette;
}

/** One shared palette for every frame, from an even sample of all their pixels. */
function paletteFor(frames: RgbaImage[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + frame.width * frame.height, 0);
  const step = Math.max(1, Math.floor(total / PALETTE_SAMPLES));
  const picked: number[] = [];
  let seen = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.width * frame.height; i++, seen++) {
      if (seen % step !== 0) continue;
      picked.push(...flatten(frame.data, i * 4));
    }
  }
  return medianCut(Uint8Array.from(picked), PALETTE_SIZE);
}

/** Palette indices for a frame; nearest colours are cached at 5 bits a channel. */
function indexer(palette: Uint8Array): (data: Uint8Array, pixels: number) => Uint8Array {
  const cache = new Int16Array(32 * 32 * 32).fill(-1);
  const nearest = (r: number, g: number, b: number): number => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key]!;
    if (hit >= 0) return hit;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const dr = palette[i * 3]! - r;
      const dg = palette[i * 3 + 1]! - g;
      const db = palette[i * 3 + 2]! - b;
      const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };
  return (data, pixels) => {
    const out = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) out[i] = nearest(...flatten(data, i * 4));
    return out;
  };
}

/** GIF's variable-width LZW over 8-bit indices, as the image data's sub-blocks. */
function lzw(indices: Uint8Array): Buffer {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const bytes: number[] = [];
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let table = new Map<number, number>();
  let bits = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      table = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize += 1;
      table.set(key, nextCode++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) bytes.push(bits & 0xff);

  const blocks: number[] = [minCodeSize];
  for (let at = 0; at < bytes.length; at += 255) {
    const block = bytes.slice(at, at + 255);
    blocks.push(block.length, ...block);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

/**
 * The frames as one looping animated GIF. Every frame must be the same
 * size (resize them first); there must be at least one.
 */
export function encodeGif(frames: RgbaImage[], options: GifOptions): Buffer {
  const first = frames[0];
  if (!first) throw new Error('A GIF needs at least one frame.');
  if (frames.length > GIF_MAX_FRAMES)
    throw new Error(`A GIF may have at most ${GIF_MAX_FRAMES} frames.`);
  const { width, height } = first;
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new Error('A GIF frame must be 1–65535 pixels on each side.');
  }
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error('Every GIF frame must be the same size.');
    }
  }
  const palette = paletteFor(frames);
  const toIndices = indexer(palette);
  const delay = Math.max(2, Math.min(0xffff, Math.round(options.delayMs / 10)));

  const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
  const parts: Buffer[] = [
    Buffer.from('GIF89a', 'latin1'),
    // Logical screen: the size, a global 256-colour table (2^(7+1)), background 0.
    Buffer.from([...u16(width), ...u16(height), 0xf7, 0, 0]),
    Buffer.from(palette),
    // NETSCAPE2.0: loop forever.
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0, 0, 0]),
  ];
  for (const frame of frames) {
    parts.push(
      // Graphic control: leave the frame in place, this delay, no transparency.
      Buffer.from([0x21, 0xf9, 0x04, 0x04, ...u16(delay), 0, 0]),
      // Image descriptor: the whole screen, the global palette, not interlaced.
      Buffer.from([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0]),
      lzw(toIndices(frame.data, width * height))
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
