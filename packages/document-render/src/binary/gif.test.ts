/**
 * Pixels and animated GIFs: a PNG decodes to the same pixels however it is
 * stored (palette, interlaced, our own RGBA), resizing averages, and a GIF
 * written from frames decodes — with an independent LZW decoder written
 * here — back to those frames, looping, with the delay asked for.
 */

import { encodeGif, GIF_MAX_FRAMES } from './gif';
import { coverRgba, decodePng, encodePng, fitWithin, resizeRgba, type RgbaImage } from './pixels';
import { png, pngInterlaced, pngCommented } from './test-fixtures';

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

function decoded(bytes: Buffer): RgbaImage {
  const result = decodePng(bytes);
  if (!result.ok) throw new Error(result.reason);
  return result.image;
}

/** A small GIF reader: the screen, the loop extension, and each frame's delay and RGB pixels. */
function readGif(bytes: Buffer) {
  expect(bytes.toString('latin1', 0, 6)).toBe('GIF89a');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const flags = bytes[10]!;
  expect(flags & 0x80).toBe(0x80);
  const tableSize = 3 * 2 ** ((flags & 7) + 1);
  const palette = bytes.subarray(13, 13 + tableSize);
  let pos = 13 + tableSize;
  let loops = false;
  let delay = 0;
  const frames: Array<{ delay: number; rgb: Uint8Array }> = [];
  const subBlocks = () => {
    const out: number[] = [];
    for (let size = bytes[pos++]!; size > 0; size = bytes[pos++]!) {
      out.push(...bytes.subarray(pos, pos + size));
      pos += size;
    }
    return out;
  };
  while (pos < bytes.length) {
    const introducer = bytes[pos++]!;
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = bytes[pos++]!;
      if (label === 0xff) {
        const size = bytes[pos++]!;
        loops ||= bytes.toString('latin1', pos, pos + size) === 'NETSCAPE2.0';
        pos += size;
        subBlocks();
      } else if (label === 0xf9) {
        const block = subBlocks();
        delay = block[1]! | (block[2]! << 8);
      } else {
        subBlocks();
      }
      continue;
    }
    expect(introducer).toBe(0x2c);
    const w = bytes.readUInt16LE(pos + 4);
    const h = bytes.readUInt16LE(pos + 6);
    expect([w, h]).toEqual([width, height]);
    expect(bytes[pos + 8]! & 0x80).toBe(0); // the global palette, no local one
    pos += 9;
    const minCodeSize = bytes[pos++]!;
    const data = subBlocks();
    // LZW decode.
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let codeSize = minCodeSize + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = Array.from({ length: clear + 2 }, (_, i) => (i < clear ? [i] : []));
      codeSize = minCodeSize + 1;
    };
    reset();
    const indices: number[] = [];
    let bit = 0;
    let previous: number[] | null = null;
    while (bit + codeSize <= data.length * 8) {
      let code = 0;
      for (let i = 0; i < codeSize; i++, bit++) {
        code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
      }
      if (code === clear) {
        reset();
        previous = null;
        continue;
      }
      if (code === end) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else if (previous) entry = [...previous, previous[0]!];
      else throw new Error('bad LZW stream');
      indices.push(...entry);
      if (previous) dict.push([...previous, entry[0]!]);
      previous = entry;
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    expect(indices).toHaveLength(width * height);
    const rgb = new Uint8Array(width * height * 3);
    indices.forEach((index, i) => rgb.set(palette.subarray(index * 3, index * 3 + 3), i * 3));
    frames.push({ delay, rgb });
  }
  return { width, height, loops, frames };
}

describe('decodePng', () => {
  it('reads a palette PNG and its interlaced twin as the same pixels', () => {
    const plain = decoded(png);
    const interlaced = decoded(pngInterlaced);
    expect([plain.width, plain.height]).toEqual([24, 16]);
    expect(Array.from(interlaced.data)).toEqual(Array.from(plain.data));
    // A red → blue gradient, top to bottom, fully opaque.
    expect(Array.from(plain.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(plain.data.subarray(15 * 24 * 4, 15 * 24 * 4 + 4))).toEqual([0, 0, 255, 255]);
  });

  it('reads through a file whose extra chunks the validator drops', () => {
    expect(decoded(pngCommented).width).toBe(24);
  });

  it('refuses what is not a PNG', () => {
    const result = decodePng(Buffer.from('<script>alert(1)</script>'));
    expect(result.ok).toBe(false);
  });

  it('round-trips through encodePng', () => {
    const image = decoded(png);
    const again = decoded(encodePng(image));
    expect(Array.from(again.data)).toEqual(Array.from(image.data));
  });
});

describe('resizing', () => {
  it('fits a shape within a side without growing it', () => {
    expect(fitWithin({ width: 1536, height: 1024 }, 512)).toEqual({ width: 512, height: 341 });
    expect(fitWithin({ width: 1024, height: 1024 }, 512)).toEqual({ width: 512, height: 512 });
    expect(fitWithin({ width: 300, height: 200 }, 512)).toEqual({ width: 300, height: 200 });
  });

  it('averages the pixels a smaller one covers', () => {
    const image: RgbaImage = {
      width: 2,
      height: 1,
      data: Uint8Array.from([0, 0, 0, 255, 200, 100, 50, 255]),
    };
    expect(Array.from(resizeRgba(image, 1, 1).data)).toEqual([100, 50, 25, 255]);
    expect(resizeRgba(solid(8, 8, [1, 2, 3, 255]), 16, 4).data.length).toBe(16 * 4 * 4);
  });
});

describe('coverRgba', () => {
  it('trims a picture of another shape to the middle instead of stretching it', () => {
    // 3 wide, 1 tall: red | green | blue. A 1x1 cover keeps the green middle.
    const image: RgbaImage = {
      width: 3,
      height: 1,
      data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
    };
    expect(Array.from(coverRgba(image, 1, 1).data)).toEqual([0, 255, 0, 255]);
    // 1 wide, 3 tall, covered to 2x2: the middle row, repeated.
    const tall: RgbaImage = { ...image, width: 1, height: 3 };
    expect(Array.from(coverRgba(tall, 2, 2).data.subarray(0, 4))).toEqual([0, 255, 0, 255]);
    // Same shape: a plain resize.
    expect(coverRgba(solid(1024, 576, [5, 5, 5, 255]), 512, 288).width).toBe(512);
  });
});

describe('encodeGif', () => {
  it('writes a looping GIF whose frames decode back to the pixels, with the delay asked for', () => {
    const frames = [
      solid(20, 10, [255, 0, 0, 255]),
      solid(20, 10, [0, 128, 0, 255]),
      solid(20, 10, [0, 0, 255, 255]),
    ];
    const gif = readGif(encodeGif(frames, { delayMs: 250 }));
    expect([gif.width, gif.height, gif.loops]).toEqual([20, 10, true]);
    expect(gif.frames.map((frame) => frame.delay)).toEqual([25, 25, 25]);
    expect(Array.from(gif.frames[0]!.rgb.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(gif.frames[1]!.rgb.subarray(0, 3))).toEqual([0, 128, 0]);
    expect(Array.from(gif.frames[2]!.rgb.subarray(57, 60))).toEqual([0, 0, 255]);
  });

  it('keeps a real picture close, through code-size growth and table resets', () => {
    // A noisy gradient: enough distinct runs to fill the 4096-entry table more than once.
    const width = 256;
    const height = 128;
    const data = new Uint8Array(width * height * 4);
    let seed = 7;
    for (let i = 0; i < width * height; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data.set([i % width, (i / width) * 2, seed & 0xff, 255], i * 4);
    }
    const image = { width, height, data };
    const gif = readGif(encodeGif([image, image], { delayMs: 100 }));
    let error = 0;
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++)
        error += Math.abs(gif.frames[1]!.rgb[i * 3 + c]! - data[i * 4 + c]!);
    }
    // 256 colours for ~32k random ones: close on average, not exact.
    expect(error / (width * height * 3)).toBeLessThan(24);
  });

  it('flattens transparency onto white', () => {
    const gif = readGif(encodeGif([solid(4, 4, [0, 0, 0, 0])], { delayMs: 100 }));
    expect(Array.from(gif.frames[0]!.rgb.subarray(0, 3))).toEqual([255, 255, 255]);
  });

  it('refuses frames of different sizes, none, or too many', () => {
    expect(() => encodeGif([], { delayMs: 100 })).toThrow(/at least one/);
    expect(() =>
      encodeGif([solid(2, 2, [0, 0, 0, 255]), solid(3, 2, [0, 0, 0, 255])], { delayMs: 100 })
    ).toThrow(/same size/);
    expect(() =>
      encodeGif(Array(GIF_MAX_FRAMES + 1).fill(solid(1, 1, [0, 0, 0, 255])), { delayMs: 100 })
    ).toThrow(/at most/);
  });
});
