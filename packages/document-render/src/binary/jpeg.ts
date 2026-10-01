/**
 * JPEG, rebuilt. The file is walked marker by marker and only what draws
 * the picture is copied: the quantisation and Huffman tables, the frame
 * header, restart interval and the scans' entropy-coded data. APPn
 * segments (EXIF, XMP, ICC, vendor blobs), comments, unknown or
 * arithmetic/lossless/hierarchical markers and everything after EOI are
 * not carried over — a JFIF/HTML polyglot or a payload parked in an EXIF
 * field cannot survive. Only baseline and progressive Huffman JPEGs of 1
 * or 3 components are accepted.
 */

import {
  IMAGE_FILE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_SIDE,
  refuse,
  type BinaryCheck,
} from './types';

const SOF_BASELINE_AND_PROGRESSIVE = new Set([0xc0, 0xc1, 0xc2]);

function segmentOf(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/** Checks one DQT segment's tables; true when it is exactly whole tables. */
function validDqt(data: Buffer): boolean {
  let i = 0;
  while (i < data.length) {
    const precision = data[i]! >> 4;
    const id = data[i]! & 0x0f;
    if (precision > 1 || id > 3) return false;
    i += 1 + 64 * (precision + 1);
  }
  return i === data.length && data.length > 0;
}

function validDht(data: Buffer): boolean {
  let i = 0;
  while (i < data.length) {
    const cls = data[i]! >> 4;
    const id = data[i]! & 0x0f;
    if (cls > 1 || id > 3 || i + 17 > data.length) return false;
    let symbols = 0;
    for (let k = 1; k <= 16; k++) symbols += data[i + k]!;
    if (symbols > 256) return false;
    i += 17 + symbols;
  }
  return i === data.length && data.length > 0;
}

export function sanitizeJpeg(input: Buffer): BinaryCheck {
  if (input.length > IMAGE_FILE_MAX_BYTES) {
    return refuse(`The JPEG is larger than ${IMAGE_FILE_MAX_BYTES} bytes.`);
  }
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8 || input[2] !== 0xff) {
    return refuse('This is not a JPEG: it must start with the SOI marker (FF D8 FF).');
  }
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let pos = 2;
  let frame: { components: number; width: number; height: number } | null = null;
  let tables = { dqt: false, dht: false };
  let scans = 0;
  let sawEoi = false;
  let dropped = 0;

  while (pos < input.length) {
    if (input[pos] !== 0xff) return refuse('The JPEG has stray bytes between segments.');
    while (input[pos] === 0xff && pos < input.length) pos += 1; // fill bytes
    const marker = input[pos]!;
    pos += 1;
    if (marker === 0xd9) {
      sawEoi = true;
      break;
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return refuse('The JPEG has a marker out of place.');
    }
    if (pos + 2 > input.length) return refuse('The JPEG is truncated inside a segment header.');
    const length = input.readUInt16BE(pos);
    if (length < 2 || pos + length > input.length)
      return refuse('A JPEG segment overruns the file.');
    const data = input.subarray(pos + 2, pos + length);
    pos += length;

    if (marker >= 0xe0 && marker <= 0xef) {
      dropped += 1;
    } else if (marker === 0xfe) {
      dropped += 1;
    } else if (SOF_BASELINE_AND_PROGRESSIVE.has(marker)) {
      if (frame) return refuse('The JPEG declares more than one frame.');
      if (data.length < 6) return refuse('The JPEG frame header is too short.');
      const precision = data[0]!;
      const height = data.readUInt16BE(1);
      const width = data.readUInt16BE(3);
      const components = data[5]!;
      if (precision !== 8) return refuse('Only 8-bit JPEGs are accepted.');
      if (width < 1 || height < 1 || width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
        return refuse(`The JPEG must be between 1 and ${IMAGE_MAX_SIDE} pixels on each side.`);
      }
      if (width * height > IMAGE_MAX_PIXELS)
        return refuse(`The JPEG covers more than ${IMAGE_MAX_PIXELS} pixels.`);
      if ((components !== 1 && components !== 3) || data.length !== 6 + 3 * components) {
        return refuse('Only greyscale (1) or colour (3 component) JPEGs are accepted.');
      }
      for (let c = 0; c < components; c++) {
        const sampling = data[7 + 3 * c]!;
        const h = sampling >> 4;
        const v = sampling & 0x0f;
        if (h < 1 || h > 4 || v < 1 || v > 4 || data[8 + 3 * c]! > 3) {
          return refuse('The JPEG frame header has invalid component settings.');
        }
      }
      frame = { components, width, height };
      out.push(segmentOf(marker, data));
    } else if (marker === 0xdb) {
      if (!validDqt(data)) return refuse('A JPEG quantisation table is malformed.');
      tables = { ...tables, dqt: true };
      out.push(segmentOf(marker, data));
    } else if (marker === 0xc4) {
      if (!validDht(data)) return refuse('A JPEG Huffman table is malformed.');
      tables = { ...tables, dht: true };
      out.push(segmentOf(marker, data));
    } else if (marker === 0xdd) {
      if (data.length !== 2) return refuse('The JPEG restart-interval segment is malformed.');
      out.push(segmentOf(marker, data));
    } else if (marker === 0xda) {
      if (!frame) return refuse('The JPEG has a scan before its frame header.');
      if (!tables.dqt || !tables.dht)
        return refuse('The JPEG scan comes before its quantisation and Huffman tables.');
      const ns = data[0] ?? 0;
      if (ns < 1 || ns > frame.components || data.length !== 4 + 2 * ns) {
        return refuse('The JPEG scan header is malformed.');
      }
      // Entropy-coded data runs to the next marker that is not stuffing (FF 00) or a restart (FF D0–D7).
      let end = pos;
      for (;;) {
        const ff = input.indexOf(0xff, end);
        if (ff === -1 || ff + 1 >= input.length)
          return refuse('The JPEG ends inside scan data (truncated).');
        let next = ff + 1;
        while (input[next] === 0xff && next + 1 < input.length) next += 1;
        const m = input[next]!;
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
          end = next + 1;
          continue;
        }
        end = ff;
        break;
      }
      scans += 1;
      out.push(segmentOf(marker, data), input.subarray(pos, end));
      pos = end;
    } else {
      return refuse(
        `The JPEG uses marker FF ${marker.toString(16).toUpperCase().padStart(2, '0')}, which is not accepted (only baseline and progressive Huffman JPEGs are).`
      );
    }
  }
  if (!sawEoi) return refuse('The JPEG ends without an EOI marker (truncated).');
  if (!frame || scans === 0) return refuse('The JPEG has no image data.');
  out.push(Buffer.from([0xff, 0xd9]));

  const notes: string[] = [];
  if (dropped > 0)
    notes.push(`${dropped} JPEG metadata segment(s) (EXIF, comments, profiles) were removed.`);
  if (pos < input.length - 1) notes.push('Bytes after the end of the JPEG were removed.');
  return {
    ok: true,
    bytes: Buffer.concat(out),
    mediaType: 'image/jpeg',
    notes,
    width: frame.width,
    height: frame.height,
  };
}
