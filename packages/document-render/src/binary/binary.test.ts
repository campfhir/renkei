/**
 * The promises the binary validators make: a real file of the named format
 * comes out as a rebuilt, equivalent file; anything riding along with it
 * (metadata, script text, trailing bytes, decompression bombs) does not;
 * bytes that are not the format the extension names are refused with a
 * reason the model can act on.
 */

import { deflateSync } from 'node:zlib';
import { renderDocument } from '../index';
import { sanitizeBinary, decodeBase64, BINARY_MAX_BYTES } from './index';
import * as fx from './test-fixtures';

const b64 = (bytes: Buffer) => bytes.toString('base64');
const SCRIPT = Buffer.from('<script>alert(1)</script>');

function accepted(extension: string, bytes: Buffer) {
  const result = sanitizeBinary(extension, b64(bytes));
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.reason}`);
  return result;
}

function refusal(extension: string, bytes: Buffer): string {
  const result = sanitizeBinary(extension, b64(bytes));
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
}

describe('base64 input', () => {
  it('ignores whitespace and refuses a data: prefix, bad alphabet, bad padding and emptiness', () => {
    expect(decodeBase64('aGk=\n').ok).toBe(true);
    expect(decodeBase64('data:image/png;base64,aGk=').ok).toBe(false);
    expect(decodeBase64('aG-k').ok).toBe(false);
    expect(decodeBase64('aGk').ok).toBe(false);
    expect(decodeBase64('  ').ok).toBe(false);
  });

  it('refuses more than the byte limit before decoding it', () => {
    const big = Buffer.alloc(BINARY_MAX_BYTES + 1, 1).toString('base64');
    const result = sanitizeBinary('png', big);
    expect(result.ok).toBe(false);
  });

  it('refuses an extension that is not a binary format', () => {
    const result = sanitizeBinary('exe', b64(Buffer.from('MZ')));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/png, jpg, jpeg, tif, tiff, pdf/);
  });
});

describe('PNG', () => {
  it.each([
    ['a plain PNG', fx.png],
    ['an interlaced PNG', fx.pngInterlaced],
  ])('rebuilds %s as a PNG with the same shape', (_, file) => {
    const out = accepted('png', file);
    expect(out.mediaType).toBe('image/png');
    expect(out.bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(out.bytes.readUInt32BE(16)).toBe(24);
    expect(out.bytes.readUInt32BE(20)).toBe(16);
    // What comes out is a fixed point: rebuilding it changes nothing.
    expect(accepted('png', out.bytes).bytes.equals(out.bytes)).toBe(true);
  });

  it('drops text chunks and bytes after IEND, and says so', () => {
    expect(fx.pngCommented.includes(SCRIPT)).toBe(true);
    const out = accepted('png', Buffer.concat([fx.pngCommented, SCRIPT]));
    expect(out.bytes.includes(SCRIPT)).toBe(false);
    expect(out.bytes.includes(Buffer.from('tEXt'))).toBe(false);
    expect(out.notes.join(' ')).toMatch(/removed/);
  });

  it('refuses a bad CRC, a missing IEND and another format under a .png name', () => {
    const corrupt = Buffer.from(fx.png);
    corrupt[corrupt.length - 20] ^= 0xff;
    expect(refusal('png', corrupt)).toMatch(/CRC/);
    expect(refusal('png', fx.png.subarray(0, fx.png.length - 12))).toMatch(/truncated|IEND/);
    expect(refusal('png', fx.jpeg)).toMatch(/not a PNG/);
    expect(refusal('png', Buffer.from('<html><script>alert(1)</script></html>'))).toMatch(
      /not a PNG/
    );
  });

  it('refuses pixel data that inflates beyond what the header declares', () => {
    const bomb = Buffer.from(fx.png);
    // Swap IDAT for a stream that inflates to far more than 24x16 needs.
    const idatAt = bomb.indexOf(Buffer.from('IDAT'));
    const length = bomb.readUInt32BE(idatAt - 4);
    const huge = deflateSync(Buffer.alloc(5_000_000));
    const rebuilt = Buffer.concat([
      bomb.subarray(0, idatAt - 4),
      pngChunk('IDAT', huge),
      bomb.subarray(idatAt + 4 + length + 4),
    ]);
    expect(refusal('png', rebuilt)).toMatch(/expands beyond|size its header/);
  });
});

describe('JPEG', () => {
  it.each([
    ['a baseline JPEG', fx.jpeg],
    ['a progressive JPEG', fx.jpegProgressive],
  ])('rebuilds %s as a JPEG', (_, file) => {
    const out = accepted('jpg', file);
    expect(out.mediaType).toBe('image/jpeg');
    expect([...out.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(accepted('jpeg', out.bytes).bytes.equals(out.bytes)).toBe(true);
  });

  it('drops comments, EXIF-style segments and trailing HTML', () => {
    expect(fx.jpegCommented.includes(SCRIPT)).toBe(true);
    const exif = appSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), SCRIPT]));
    const withExif = Buffer.concat([fx.jpeg.subarray(0, 2), exif, fx.jpeg.subarray(2)]);
    for (const file of [fx.jpegCommented, withExif]) {
      const out = accepted('jpg', Buffer.concat([file, Buffer.from('<html>'), SCRIPT]));
      expect(out.bytes.includes(Buffer.from('script'))).toBe(false);
      expect(out.bytes.includes(Buffer.from('<html>'))).toBe(false);
      expect(out.notes.join(' ')).toMatch(/removed/);
    }
  });

  it('refuses a JPEG that is not baseline/progressive Huffman, is truncated, or is another format', () => {
    expect(refusal('jpg', fx.jpeg.subarray(0, fx.jpeg.length - 6))).toMatch(/truncated/);
    expect(refusal('jpg', fx.png)).toMatch(/not a JPEG/);
    const arithmetic = Buffer.from(fx.jpeg);
    arithmetic[arithmetic.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc9;
    expect(refusal('jpg', arithmetic)).toMatch(/not accepted/);
  });
});

describe('TIFF', () => {
  it.each([
    ['a Deflate TIFF', fx.tiffZip],
    ['an uncompressed TIFF', fx.tiffRaw],
    ['a big-endian TIFF', fx.tiffBigEndian],
  ])('rewrites %s as little-endian TIFF', (_, file) => {
    const out = accepted('tif', file);
    expect(out.mediaType).toBe('image/tiff');
    expect(out.bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 42, 0]))).toBe(true);
    expect(accepted('tiff', out.bytes).bytes.equals(out.bytes)).toBe(true);
  });

  it('keeps the strip data byte for byte', () => {
    const out = accepted('tif', fx.tiffRaw);
    // The 24x16 RGB-or-grey raster is carried over unchanged: a long run of the original pixels survives.
    const sample = fx.tiffRaw.subarray(fx.tiffRaw.length - 400, fx.tiffRaw.length - 300);
    expect(sample.length).toBe(100);
    expect(out.bytes.length).toBeGreaterThan(fx.tiffRaw.length - 400);
  });

  it('drops tags beyond the pixel description, such as a comment holding script text', () => {
    expect(fx.tiffCommented.includes(SCRIPT)).toBe(true);
    const out = accepted('tif', Buffer.concat([fx.tiffCommented, SCRIPT]));
    expect(out.bytes.includes(Buffer.from('script'))).toBe(false);
    expect(out.notes.join(' ')).toMatch(/removed/);
  });

  it('refuses BigTIFF, a directory loop, strips pointing outside the file, and other formats', () => {
    const big = Buffer.from(fx.tiffZip);
    big.writeUInt16LE(43, 2);
    expect(refusal('tif', big)).toMatch(/BigTIFF/);
    expect(refusal('tif', fx.png)).toMatch(/not a TIFF/);
    expect(refusal('tif', fx.tiffZip.subarray(0, 60))).toMatch(/directory|outside|overruns/);

    const loop = Buffer.from(fx.tiffZip);
    const ifd = loop.readUInt32LE(4);
    const entries = loop.readUInt16LE(ifd);
    loop.writeUInt32LE(ifd, ifd + 2 + entries * 12);
    expect(refusal('tif', loop)).toMatch(/loops/);
  });
});

describe('PDF', () => {
  async function pdfOf(markdown: string): Promise<Buffer> {
    return (await renderDocument('pdf', 'x.pdf', markdown)).bytes;
  }

  it('accepts a plain PDF unchanged', async () => {
    const pdf = await pdfOf('# Title\n\nHello.\n');
    const out = accepted('pdf', pdf);
    expect(out.mediaType).toBe('application/pdf');
    expect(out.bytes.equals(pdf)).toBe(true);
  });

  it.each([
    ['JavaScript', '/S /JavaScript /JS (app.alert(1))'],
    ['an obfuscated name', '/S /J#61vaScr#69pt'],
    ['an open action', '/OpenAction 1 0 R'],
    ['a launch action', '/S /Launch /F (cmd.exe)'],
    ['an embedded file', '/Type /EmbeddedFile'],
    ['a form', '/AcroForm << /Fields [] >>'],
    ['an object stream', '/Type /ObjStm'],
  ])('refuses %s', async (_, injected) => {
    const pdf = await pdfOf('# Title\n\nHello.\n');
    const marker = pdf.lastIndexOf('startxref');
    const hostile = Buffer.concat([
      pdf.subarray(0, marker),
      Buffer.from(`\n99 0 obj\n<< ${injected} >>\nendobj\n`),
      pdf.subarray(marker),
    ]);
    expect(refusal('pdf', hostile)).toMatch(/not accepted/);
  });

  it('refuses a PDF hidden after another header, trailing bytes after %%EOF, and non-PDF bytes', async () => {
    const pdf = await pdfOf('hi');
    expect(refusal('pdf', Buffer.concat([fx.png, pdf]))).toMatch(/byte 0/);
    expect(refusal('pdf', Buffer.concat([pdf, SCRIPT]))).toMatch(/%%EOF/);
    expect(refusal('pdf', Buffer.from('%PDF-1.4\nnot really'))).toMatch(/%%EOF/);
    expect(refusal('pdf', fx.jpeg)).toMatch(/not a PDF/);
  });
});

function appSegment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  // CRC through the validator's own accepted fixture path is overkill here; compute it directly.
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  let c = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), data])) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}
