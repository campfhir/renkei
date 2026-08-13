/**
 * The package's shared vocabulary. No logic, no I/O — the same split
 * email-sanitizer keeps between types.ts and its pipeline.
 */

export type DocumentFormat =
  'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'markdown' | 'csv' | 'html';

export type ExtractErrorTag =
  /** Legacy .doc/.xls/.ppt, images, archives, unknown bytes. */
  | 'UNSUPPORTED_FORMAT'
  /** Refused on declared size, before decoding. */
  | 'INPUT_TOO_LARGE'
  /** Password-protected PDF, or OOXML wrapped in a CFB EncryptedPackage. */
  | 'ENCRYPTED'
  /** Bad archive, missing required part, malformed document. */
  | 'CORRUPT'
  /** Parsed cleanly but yielded nothing worth indexing. */
  | 'EMPTY'
  | 'EXTRACTION_FAILED';

export type ExtractNote =
  /** Pages exist but carry no text layer. There is no OCR here. */
  | 'scanned-pdf'
  /** The character budget was spent before the document ended. */
  | 'output-truncated'
  /** A part failed its guard and was dropped; the rest was read. */
  | 'parts-skipped';

export interface ExtractedDocument {
  format: DocumentFormat;
  /** Plain text, ready for chunkText(). Never empty on the ok branch. */
  text: string;
  truncated: boolean;
  /** PDF pages / xlsx sheets / pptx slides. Absent for flat formats. */
  sections?: number;
  notes: ExtractNote[];
}

export interface ExtractOptions {
  /** Graph's file.mimeType — the LOWEST-priority format signal. */
  contentType?: string;
  /** Used for the extension tiebreak and in diagnostics. */
  fileName?: string;
  maxInputBytes?: number;
  maxChars?: number;
}

/** 25 MiB. Also the pre-download gate against driveItem.size. */
export const DEFAULT_MAX_INPUT_BYTES = 26_214_400;

/**
 * 600k characters ≈ 300 chunks at knowledge's 2000-char default ≈ 5 embedding
 * round trips at a batch of 64. A document costing more than that is not a
 * document, it is a data dump — and the budget is what actually bounds
 * extraction runtime, more than any timeout.
 */
export const DEFAULT_MAX_CHARS = 600_000;

/**
 * A shared character budget threaded through every extractor, so a huge
 * spreadsheet stops being read the moment it can no longer contribute.
 */
export class TextBudget {
  private readonly parts: string[] = [];
  private used = 0;
  private overflowed = false;

  constructor(private readonly maxChars: number = DEFAULT_MAX_CHARS) {}

  /** True once nothing further can be accepted — callers should stop work. */
  get spent(): boolean {
    return this.used >= this.maxChars;
  }

  get truncated(): boolean {
    return this.overflowed;
  }

  push(text: string): void {
    if (!text || this.spent) {
      if (text) this.overflowed = true;
      return;
    }
    const remaining = this.maxChars - this.used;
    if (text.length <= remaining) {
      this.parts.push(text);
      this.used += text.length;
      return;
    }
    this.parts.push(text.slice(0, remaining));
    this.used = this.maxChars;
    this.overflowed = true;
  }

  toString(): string {
    return this.parts.join('');
  }
}

/** Collapse runs of blank lines and trailing spaces the formats leave behind. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
