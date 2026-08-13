/**
 * Deciding what a file actually is.
 *
 * Precedence is magic bytes → archive contents → extension → contentType, and
 * the order is load-bearing:
 *
 * - Magic bytes are the only signal the FILE provides. Everything else is a
 *   third party's claim about a file it never parsed.
 * - A ZIP's flavour must come from its entry names, never its extension, so
 *   .docm/.xlsm/.potx and renamed files all resolve correctly — and a .docx
 *   that is really a .xlsx (common in real tenants) parses as what it is.
 * - Graph's file.mimeType is LAST because SharePoint derives it from the
 *   extension and routinely reports application/octet-stream for perfectly
 *   good documents. Trusting it over the bytes would lose information.
 * - Extension only breaks ties inside the plain-text family, where the bytes
 *   genuinely cannot tell .csv from .md from .txt.
 */

import type { DocumentFormat } from './types';
import { readZipEntries } from './zip';

export type DetectResult =
  | { kind: 'format'; format: DocumentFormat }
  /** A password-protected OOXML file: a CFB container, not a zip at all. */
  | { kind: 'encrypted' }
  | { kind: 'unsupported'; reason: string };

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Some PDFs carry leading junk before %PDF; the spec tolerates it, so do we. */
function looksLikePdf(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 1024);
  const text = new TextDecoder('latin1').decode(window);
  return text.includes('%PDF-');
}

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function extensionOf(fileName: string | undefined): string {
  if (!fileName) return '';
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** Printable-enough to be text, with no NUL bytes. */
function looksLikeText(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 4096);
  if (window.length === 0) return false;
  let printable = 0;
  for (const byte of window) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128) {
      printable += 1;
    }
  }
  return printable / window.length > 0.95;
}

export function detectFormat(
  bytes: Uint8Array,
  hints?: { contentType?: string; fileName?: string }
): DetectResult {
  if (bytes.length === 0) return { kind: 'unsupported', reason: 'empty file' };

  if (looksLikePdf(bytes)) return { kind: 'format', format: 'pdf' };

  // PK\x03\x04 — a zip, so read the index to learn which OOXML flavour.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const listed = readZipEntries(bytes);
    if (!listed.ok) return { kind: 'unsupported', reason: 'unreadable archive' };
    const names = new Set(listed.val.map((entry) => entry.name));
    if (names.has('word/document.xml')) return { kind: 'format', format: 'docx' };
    if (names.has('xl/workbook.xml')) return { kind: 'format', format: 'xlsx' };
    if (names.has('ppt/presentation.xml')) return { kind: 'format', format: 'pptx' };
    if (names.has('mimetype')) {
      return { kind: 'unsupported', reason: 'OpenDocument format is not supported' };
    }
    return { kind: 'unsupported', reason: 'archive is not an Office document' };
  }

  // OLE2/CFB. Either a password-protected OOXML file or a legacy binary
  // Office document — a distinction worth making, because "encrypted" is
  // actionable and "unsupported" is not.
  if (startsWith(bytes, OLE2_MAGIC)) {
    const head = decodeAscii(bytes.subarray(0, 8192));
    // The marker is UTF-16 inside CFB, so the name appears letter-spaced.
    if (
      head.includes('E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e') ||
      head.includes('EncryptedPackage')
    ) {
      return { kind: 'encrypted' };
    }
    return {
      kind: 'unsupported',
      reason: 'legacy Office format (.doc/.xls/.ppt) is not supported',
    };
  }

  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return { kind: 'unsupported', reason: 'RTF is not supported' };
  }

  if (looksLikeText(bytes)) {
    switch (extensionOf(hints?.fileName)) {
      case 'csv':
        return { kind: 'format', format: 'csv' };
      case 'md':
      case 'markdown':
        return { kind: 'format', format: 'markdown' };
      case 'htm':
      case 'html':
      case 'aspx':
        return { kind: 'format', format: 'html' };
      default:
        return { kind: 'format', format: 'text' };
    }
  }

  return { kind: 'unsupported', reason: 'unrecognized file type' };
}

/**
 * The PRE-DOWNLOAD gate: name, type and size only, no bytes. The drive sync
 * calls this against driveItem fields so a 400MB video is never fetched.
 */
export function isExtractableCandidate(item: {
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  maxInputBytes?: number;
}): boolean {
  if (item.sizeBytes !== undefined && item.maxInputBytes !== undefined) {
    if (item.sizeBytes > item.maxInputBytes) return false;
  }
  if (item.sizeBytes === 0) return false;

  const extension = extensionOf(item.fileName);
  const known = new Set([
    'pdf',
    'docx',
    'docm',
    'dotx',
    'xlsx',
    'xlsm',
    'xltx',
    'pptx',
    'pptm',
    'potx',
    'txt',
    'md',
    'markdown',
    'csv',
    'htm',
    'html',
  ]);
  if (extension) return known.has(extension);

  // No usable extension: fall back to the declared type rather than refusing,
  // and let byte-level detection make the real call after download.
  const contentType = (item.contentType ?? '').toLowerCase();
  return (
    contentType.startsWith('text/') ||
    contentType.includes('pdf') ||
    contentType.includes('officedocument')
  );
}
