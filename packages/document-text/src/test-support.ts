/**
 * Building OOXML archives in-test.
 *
 * The repo commits no binaries outside node_modules, and this package should
 * not be the one to change that. Generated fixtures are also better evidence
 * than real files: a test that declares the exact XML construct it is about
 * ("a w:del subtree") is reviewable in the diff, where a 40KB Word document
 * is opaque and proves whatever it happens to contain.
 *
 * Not exported from index.ts — test scaffolding, not package surface.
 */

import { deflateRawSync } from 'node:zlib';

interface PendingEntry {
  name: string;
  data: Buffer;
  compressed: Buffer;
  offset: number;
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

/** A minimal, spec-shaped ZIP — deflate for every entry, no extra fields. */
export function buildZip(files: Record<string, string>): Uint8Array {
  const entries: PendingEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    entries.push({ name, data, compressed, offset });
    chunks.push(local, nameBytes, compressed);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const directoryOffset = offset;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // deflate
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(entry.offset, 42);
    chunks.push(central, nameBytes);
    offset += central.length + nameBytes.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - directoryOffset, 12);
  eocd.writeUInt32LE(directoryOffset, 16);
  chunks.push(eocd);

  return new Uint8Array(Buffer.concat(chunks));
}

/** A .docx whose document.xml body is `body`. */
export function buildDocx(body: string, extra: Record<string, string> = {}): Uint8Array {
  return buildZip({
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}

/** A paragraph of one run. */
export function paragraph(text: string, attributes = ''): string {
  return `<w:p><w:r><w:t${attributes ? ` ${attributes}` : ''}>${text}</w:t></w:r></w:p>`;
}
