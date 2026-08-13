/**
 * @renkei/document-text — plain text out of the documents a drive holds, for
 * the knowledge index.
 *
 * Read-only by design, and that is why it has no third-party parsers. The
 * off-the-shelf options are halves of libraries built to WRITE these formats;
 * extracting text needs a small fraction of that and none of the dependency
 * trees, which for a component parsing bytes any employee can upload is the
 * whole argument. OOXML is a zip of XML, and Node's zlib does the only hard
 * part, so docx/xlsx/pptx are handled here with zero runtime dependencies.
 *
 * PDF is the deliberate exception: extracting its text is not a subset of a
 * PDF library but most of one — xref tables and streams, object parsing,
 * content-stream tokenizing, and font encodings with ToUnicode CMaps to map
 * glyph codes back to characters. That is delegated (see pdf.ts).
 *
 * There is no OCR. A scanned document reports itself as such rather than
 * silently indexing nothing.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { detectFormat } from './detect';
import { readZipFiles } from './zip';
import { extractDocx, DOCX_PARTS } from './docx';
import { extractXlsx, XLSX_PARTS } from './xlsx';
import { extractPptx, PPTX_PARTS } from './pptx';
import {
  TextBudget,
  tidyText,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_INPUT_BYTES,
  type ExtractOptions,
  type ExtractErrorTag,
  type ExtractNote,
  type ExtractedDocument,
} from './types';

export { detectFormat, isExtractableCandidate } from './detect';
export {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_INPUT_BYTES,
  type DocumentFormat,
  type ExtractOptions,
  type ExtractErrorTag,
  type ExtractNote,
  type ExtractedDocument,
} from './types';

const OOXML: Record<'docx' | 'xlsx' | 'pptx', RegExp> = {
  docx: DOCX_PARTS,
  xlsx: XLSX_PARTS,
  pptx: PPTX_PARTS,
};

function decodeText(bytes: Uint8Array): string {
  // A BOM would otherwise survive into the first chunk of every text file.
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Linearize HTML without a DOM: block tags become breaks, the rest drops. */
export function htmlToDocumentText(html: string, maxChars = DEFAULT_MAX_CHARS): string {
  const budget = new TextBudget(maxChars);
  const withoutInert = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const blocks = withoutInert.replace(
    /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>/gi,
    '\n'
  );
  const cells = blocks.replace(/<\/(td|th)>/gi, ' | ');
  const stripped = cells.replace(/<[^>]+>/g, '');
  budget.push(
    stripped
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
  );
  return tidyText(budget.toString());
}

/**
 * Extract a document's text. Never throws — every failure is a tagged Err, so
 * the caller can decide what is permanent (skip it) and what is transient
 * (retry it) without parsing messages.
 */
export async function extractText(
  bytes: Uint8Array,
  options: ExtractOptions = {}
): Promise<Result<ExtractedDocument, ExtractErrorTag>> {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (bytes.byteLength > maxInputBytes) {
    return err('INPUT_TOO_LARGE' as const, {
      message: `${bytes.byteLength} bytes exceeds the ${maxInputBytes} limit`,
    });
  }

  const detected = detectFormat(bytes, options);
  if (detected.kind === 'encrypted') {
    return err('ENCRYPTED' as const, { message: 'the file is password protected' });
  }
  if (detected.kind === 'unsupported') {
    return err('UNSUPPORTED_FORMAT' as const, { message: detected.reason });
  }

  const format = detected.format;
  const budget = new TextBudget(options.maxChars ?? DEFAULT_MAX_CHARS);
  const notes: ExtractNote[] = [];
  let sections: number | undefined;

  try {
    switch (format) {
      case 'docx':
      case 'xlsx':
      case 'pptx': {
        const parts = readZipFiles(bytes, (name) => OOXML[format].test(name));
        if (!parts.ok) {
          if (parts.err.type === 'ENCRYPTED') {
            return err('ENCRYPTED' as const, { message: 'the file is password protected' });
          }
          return err('CORRUPT' as const, { message: parts.err.message ?? 'unreadable archive' });
        }
        if (format === 'docx') extractDocx(parts.val, budget);
        else if (format === 'xlsx') sections = extractXlsx(parts.val, budget);
        else sections = extractPptx(parts.val, budget);
        break;
      }
      case 'html':
        budget.push(htmlToDocumentText(decodeText(bytes), options.maxChars ?? DEFAULT_MAX_CHARS));
        break;
      case 'pdf': {
        const { extractPdfText } = await import('./pdf');
        const pdf = await extractPdfText(bytes, options.maxChars ?? DEFAULT_MAX_CHARS);
        if (!pdf.ok) return pdf;
        budget.push(pdf.val.text);
        sections = pdf.val.pages;
        if (pdf.val.scanned) notes.push('scanned-pdf');
        break;
      }
      default:
        // text, markdown and csv are already text; markdown structure helps
        // the chunker rather than hurting it, so none of it is stripped.
        budget.push(decodeText(bytes));
        break;
    }
  } catch (error) {
    return err('EXTRACTION_FAILED' as const, {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }

  const text = tidyText(budget.toString());
  if (budget.truncated) notes.push('output-truncated');

  // A scanned PDF is a valid document we simply cannot read — reporting it as
  // ok-with-a-note lets the caller index the filename and record why, which
  // is more useful than an error and more honest than empty text.
  if (!text && !notes.includes('scanned-pdf')) {
    return err('EMPTY' as const, { message: 'no extractable text' });
  }

  return ok({
    format,
    text,
    truncated: budget.truncated,
    ...(sections === undefined ? {} : { sections }),
    notes,
  });
}
