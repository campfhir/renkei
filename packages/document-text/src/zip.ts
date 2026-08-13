/**
 * A read-only ZIP reader, because that is all an OOXML document needs.
 *
 * docx, xlsx and pptx are ZIP archives of XML. Off-the-shelf readers exist,
 * but they are halves of libraries built to WRITE these formats — compression,
 * streaming, encryption, spreadsheet models — and they carry the dependency
 * trees to match. Extracting text needs exactly three operations: find the
 * entries, learn their sizes, and inflate the four or five we actually read.
 * Node's zlib does the only hard part.
 *
 * The central directory is what makes this both simple and safe. It records
 * every entry's compressed AND uncompressed size up front, so the size and
 * ratio limits are enforced BEFORE a single byte is inflated — a stronger
 * position than inspecting output as it grows. Sizes are attacker-controlled,
 * so the inflated result is re-checked against its declaration afterwards.
 *
 * Deliberately unsupported: encryption, multi-disk archives, and Deflate64
 * (a rare non-standard method some old generators emit). Each fails loudly
 * rather than silently returning partial text.
 */

import { inflateRawSync } from 'node:zlib';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export type ZipErrorTag = 'CORRUPT' | 'ENCRYPTED' | 'UNSUPPORTED_COMPRESSION' | 'ZIP_BOMB';

/** One central-directory record, before anything is decompressed. */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else we refuse. */
  method: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export interface ZipLimits {
  /** Entries examined in the central directory. */
  maxEntries?: number;
  /** Largest single inflated entry. */
  maxEntryBytes?: number;
  /** Largest total inflated across every entry read. */
  maxTotalBytes?: number;
  /** Largest uncompressed:compressed ratio for one entry. */
  maxRatio?: number;
}

const DEFAULT_LIMITS: Required<ZipLimits> = {
  maxEntries: 4096,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 200,
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** Bit 0 of the general-purpose flags means the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;

/**
 * Locate the End Of Central Directory record. It sits at the very end unless
 * the archive carries a trailing comment, so scan backwards over the maximum
 * comment length (64KB) rather than assuming a fixed offset.
 */
function findEocd(bytes: Uint8Array, view: DataView): number | null {
  const minOffset = Math.max(0, bytes.length - (0xffff + 22));
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === SIG_EOCD) return offset;
  }
  return null;
}

/**
 * Read the archive's index. Nothing is decompressed here — this is the cheap
 * pass that decides what is worth inflating and what is a bomb.
 */
export function readZipEntries(bytes: Uint8Array): Result<ZipEntry[], ZipErrorTag> {
  if (bytes.length < 22) return err('CORRUPT' as const, { message: 'too short to be a zip' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEocd(bytes, view);
  if (eocd === null) {
    return err('CORRUPT' as const, { message: 'no end-of-central-directory record' });
  }

  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset >= bytes.length) {
    return err('CORRUPT' as const, { message: 'central directory offset out of range' });
  }

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length) {
      return err('CORRUPT' as const, { message: 'central directory truncated' });
    }
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) {
      return err('CORRUPT' as const, { message: 'bad central directory signature' });
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.length) {
      return err('CORRUPT' as const, { message: 'entry name truncated' });
    }

    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    });

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return ok(entries);
}

/**
 * Inflate the entries whose names `wanted` accepts, applying every limit
 * before decompressing. Returns a map of name → bytes; entries the filter
 * rejects are never touched, which is where most of the bomb protection
 * actually comes from — media and embedded objects are simply never read.
 */
export function readZipFiles(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  limits: ZipLimits = {}
): Result<Map<string, Uint8Array>, ZipErrorTag> {
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  const listed = readZipEntries(bytes);
  if (!listed.ok) return listed;

  if (listed.val.length > bounds.maxEntries) {
    return err('ZIP_BOMB' as const, {
      message: `archive declares ${listed.val.length} entries, over the ${bounds.maxEntries} limit`,
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Uint8Array>();
  let inflatedTotal = 0;

  for (const entry of listed.val) {
    if (!wanted(entry.name)) continue;
    if (entry.encrypted) {
      return err('ENCRYPTED' as const, { message: `entry ${entry.name} is encrypted` });
    }
    if (entry.method !== 0 && entry.method !== 8) {
      return err('UNSUPPORTED_COMPRESSION' as const, {
        message: `entry ${entry.name} uses compression method ${entry.method}`,
      });
    }
    if (entry.uncompressedSize > bounds.maxEntryBytes) {
      return err('ZIP_BOMB' as const, {
        message: `entry ${entry.name} declares ${entry.uncompressedSize} bytes`,
      });
    }
    // A stored entry has a 1:1 ratio; only compressed ones can lie about it.
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > bounds.maxRatio
    ) {
      return err('ZIP_BOMB' as const, {
        message: `entry ${entry.name} has a ${Math.round(
          entry.uncompressedSize / entry.compressedSize
        )}:1 compression ratio`,
      });
    }
    inflatedTotal += entry.uncompressedSize;
    if (inflatedTotal > bounds.maxTotalBytes) {
      return err('ZIP_BOMB' as const, {
        message: `archive would inflate to over ${bounds.maxTotalBytes} bytes`,
      });
    }

    // The local header repeats the name and extra fields, and its extra
    // length may DIFFER from the central directory's — so the data offset
    // must be read from the local header itself, never computed from the
    // central record.
    const local = entry.localHeaderOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== SIG_LOCAL) {
      return err('CORRUPT' as const, { message: `bad local header for ${entry.name}` });
    }
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) {
      return err('CORRUPT' as const, { message: `entry ${entry.name} data truncated` });
    }

    const raw = bytes.subarray(dataStart, dataEnd);
    if (entry.method === 0) {
      files.set(entry.name, raw);
      continue;
    }

    let inflated: Buffer;
    try {
      inflated = inflateRawSync(raw, { maxOutputLength: bounds.maxEntryBytes });
    } catch {
      return err('CORRUPT' as const, { message: `entry ${entry.name} failed to inflate` });
    }
    // Declared sizes are attacker-controlled, so the limit checks above were
    // only a cheap first pass. This is the one that actually holds.
    if (inflated.byteLength > bounds.maxEntryBytes) {
      return err('ZIP_BOMB' as const, {
        message: `entry ${entry.name} inflated past its declared size`,
      });
    }
    files.set(entry.name, new Uint8Array(inflated));
  }

  return ok(files);
}
