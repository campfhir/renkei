/**
 * Blocks → a PDF, with pdfkit. A4 portrait with an inch of margin,
 * Helvetica for text and Courier for code, headings stepped down in
 * size, real bullets and numbers with hanging indents, tables drawn as a
 * grid that breaks across pages a row at a time, code on a grey ground,
 * quotes as an indented italic run beside a rule, and a page number in
 * the footer of every page.
 *
 * pdfkit's standard fonts cover the Latin-1 range (plus the usual
 * typographic punctuation); text outside it is reported to the caller
 * as a note rather than silently drawn as boxes.
 */

import PDFDocument from 'pdfkit';
import type { Align, Block, Inline, ListItem } from './markdown-blocks';

const PAGE = { size: 'A4' as const, margin: 72 };
const BODY_SIZE = 11;
const CODE_SIZE = 9;
const LINE_GAP = 3;
const HEADING_SIZES = [22, 17, 14, 12.5, 11.5, 11];
const LIST_INDENT = 22;
const CELL_PAD = 5;
const GREY = '#666666';
const RULE = '#BFBFBF';
const CODE_GROUND = '#F2F2F2';
const LINK = '#1A5FB4';

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
  code: 'Courier',
} as const;

/** What the standard fonts can draw: Latin-1 and the punctuation WinAnsi adds (whitespace aside). */
const DRAWABLE =
  /^[\u0020-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]*$/;

export function undrawableCharacters(text: string): string[] {
  const visible = text.replace(/\s/g, '');
  if (DRAWABLE.test(visible)) return [];
  const seen = new Set<string>();
  for (const char of visible) if (!DRAWABLE.test(char)) seen.add(char);
  return [...seen];
}

function fontFor(inline: Inline): string {
  if (inline.code) return FONT.code;
  if (inline.bold && inline.italic) return FONT.boldItalic;
  if (inline.bold) return FONT.bold;
  if (inline.italic) return FONT.italic;
  return FONT.regular;
}

type Doc = InstanceType<typeof PDFDocument>;

function contentWidth(doc: Doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function bottom(doc: Doc): number {
  return doc.page.height - doc.page.margins.bottom;
}

function ensureRoom(doc: Doc, height: number): void {
  if (doc.y + height > bottom(doc)) doc.addPage();
}

/** Writes styled runs as one flowing paragraph at the current position. */
function writeInlines(
  doc: Doc,
  inlines: Inline[],
  options: { size: number; x?: number; width?: number; align?: Align; color?: string } & {
    forceFont?: string;
  }
): void {
  const x = options.x ?? doc.page.margins.left;
  const width = options.width ?? doc.page.width - x - doc.page.margins.right;
  const runs = inlines.length > 0 ? inlines : [{ text: ' ' }];
  runs.forEach((inline, index) => {
    const last = index === runs.length - 1;
    doc
      .font(options.forceFont ?? fontFor(inline))
      .fontSize(inline.code && !options.forceFont ? options.size - 1 : options.size)
      .fillColor(inline.href ? LINK : (options.color ?? 'black'));
    const textOptions = {
      width,
      align: options.align ?? 'left',
      continued: !last,
      lineGap: LINE_GAP,
      underline: Boolean(inline.href),
      strike: Boolean(inline.strike),
      link: inline.href,
    };
    // The first run sets the left edge; the rest continue from where it
    // stopped. (pdfkit reads an undefined x as "the options", so a
    // continued run must use the two-argument form or lose them.)
    if (index === 0) doc.text(inline.text, x, undefined, textOptions);
    else doc.text(inline.text, textOptions);
  });
  doc.fillColor('black');
}

function heightOfInlines(doc: Doc, inlines: Inline[], size: number, width: number): number {
  // An estimate for page-break decisions: measured in the widest font used.
  const text = inlines.map((inline) => inline.text).join('') || ' ';
  const bold = inlines.some((inline) => inline.bold);
  doc.font(bold ? FONT.bold : FONT.regular).fontSize(size);
  return doc.heightOfString(text, { width, lineGap: LINE_GAP });
}

function writeHeading(doc: Doc, block: Extract<Block, { type: 'heading' }>): void {
  const size = HEADING_SIZES[block.level - 1] ?? BODY_SIZE;
  const height = heightOfInlines(doc, block.inlines, size, contentWidth(doc));
  ensureRoom(doc, height + size * 2);
  doc.moveDown(block.level <= 2 ? 0.9 : 0.6);
  writeInlines(
    doc,
    block.inlines.map((run) => ({ ...run, bold: true })),
    { size }
  );
  doc.moveDown(0.35);
}

function writeParagraph(doc: Doc, inlines: Inline[], x?: number, width?: number): void {
  const w = width ?? contentWidth(doc);
  ensureRoom(doc, Math.min(heightOfInlines(doc, inlines, BODY_SIZE, w), BODY_SIZE * 3));
  writeInlines(doc, inlines, { size: BODY_SIZE, x, width: w });
  doc.moveDown(0.6);
}

function writeList(
  doc: Doc,
  ordered: boolean,
  start: number,
  items: ListItem[],
  depth: number,
  x: number
): void {
  const markerX = x;
  const textX = x + LIST_INDENT;
  const width = doc.page.width - textX - doc.page.margins.right;
  items.forEach((item, index) => {
    // Bullets the standard fonts can draw: WinAnsi has no ◦ or ▪.
    const marker = ordered ? `${start + index}.` : depth === 0 ? '•' : depth === 1 ? '–' : '·';
    const height = heightOfInlines(doc, item.inlines, BODY_SIZE, width);
    ensureRoom(doc, Math.min(height, BODY_SIZE * 3));
    const y = doc.y;
    doc.font(FONT.regular).fontSize(BODY_SIZE).fillColor('black');
    doc.text(marker, markerX, y, {
      width: LIST_INDENT - 4,
      align: ordered ? 'right' : 'left',
      lineBreak: false,
    });
    doc.y = y;
    writeInlines(doc, item.inlines, { size: BODY_SIZE, x: textX, width });
    doc.moveDown(0.25);
    for (const child of item.children) {
      if (child.type === 'list')
        writeList(doc, child.ordered, child.start, child.items, depth + 1, textX);
      else writeBlocks(doc, [child], textX);
    }
  });
  doc.x = doc.page.margins.left;
  if (depth === 0) doc.moveDown(0.4);
}

function writeCode(doc: Doc, text: string, x: number): void {
  const width = doc.page.width - x - doc.page.margins.right;
  doc.font(FONT.code).fontSize(CODE_SIZE);
  const lines = text.split('\n');
  const lineHeight = doc.currentLineHeight(true) + 1;
  // Fill the ground a page at a time so the block can break across pages.
  let index = 0;
  while (index < lines.length) {
    ensureRoom(doc, lineHeight * 2 + CELL_PAD * 2);
    const room = bottom(doc) - doc.y - CELL_PAD * 2;
    const count = Math.max(1, Math.min(lines.length - index, Math.floor(room / lineHeight)));
    const chunk = lines.slice(index, index + count);
    const height = chunk.length * lineHeight + CELL_PAD * 2;
    doc.rect(x, doc.y, width, height).fill(CODE_GROUND);
    doc.fillColor('black').font(FONT.code).fontSize(CODE_SIZE);
    const top = doc.y + CELL_PAD;
    chunk.forEach((line, lineIndex) => {
      doc.text(line || ' ', x + CELL_PAD, top + lineIndex * lineHeight, {
        width: width - CELL_PAD * 2,
        lineBreak: false,
      });
    });
    doc.y = top + chunk.length * lineHeight + CELL_PAD;
    index += count;
    if (index < lines.length) doc.addPage();
  }
  doc.x = doc.page.margins.left;
  doc.moveDown(0.6);
}

function columnWidths(doc: Doc, block: Extract<Block, { type: 'table' }>, total: number): number[] {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const longest = Array.from({ length: columns }, () => 1);
  const consider = (cells: Inline[][]) =>
    cells.forEach((cell, index) => {
      const length = cell.map((run) => run.text).join('').length;
      longest[index] = Math.max(longest[index] ?? 1, Math.min(length, 40));
    });
  consider(block.header);
  block.rows.forEach(consider);
  const sum = longest.reduce((a, b) => a + b, 0);
  const min = Math.min(total / columns, 48);
  const raw = longest.map((length) => Math.max(min, (length / sum) * total));
  const scale = total / raw.reduce((a, b) => a + b, 0);
  return raw.map((width) => width * scale);
}

function writeTable(doc: Doc, block: Extract<Block, { type: 'table' }>, x: number): void {
  const total = doc.page.width - x - doc.page.margins.right;
  const widths = columnWidths(doc, block, total);
  const rows: { cells: Inline[][]; header: boolean }[] = [
    { cells: block.header, header: true },
    ...block.rows.map((cells) => ({ cells, header: false })),
  ];
  const rowHeight = (cells: Inline[][], header: boolean) =>
    Math.max(
      ...widths.map((width, index) => {
        const inlines = cells[index] ?? [];
        const text = inlines.map((run) => run.text).join('') || ' ';
        doc.font(header ? FONT.bold : FONT.regular).fontSize(BODY_SIZE - 1);
        return doc.heightOfString(text, { width: width - CELL_PAD * 2, lineGap: 1 });
      })
    ) +
    CELL_PAD * 2;

  const drawRow = (row: { cells: Inline[][]; header: boolean }) => {
    const height = rowHeight(row.cells, row.header);
    ensureRoom(doc, height);
    const top = doc.y;
    let left = x;
    widths.forEach((width, index) => {
      if (row.header) doc.rect(left, top, width, height).fill('#E7E6E6');
      doc.rect(left, top, width, height).lineWidth(0.5).stroke(RULE);
      const inlines = row.cells[index] ?? [];
      doc.y = top + CELL_PAD;
      writeInlines(doc, row.header ? inlines.map((run) => ({ ...run, bold: true })) : inlines, {
        size: BODY_SIZE - 1,
        x: left + CELL_PAD,
        width: width - CELL_PAD * 2,
        align: block.align[index] ?? 'left',
      });
      left += width;
    });
    doc.y = top + height;
  };
  rows.forEach(drawRow);
  doc.x = doc.page.margins.left;
  doc.moveDown(0.8);
}

function writeQuote(doc: Doc, blocks: Block[], x: number): void {
  const inset = x + 14;
  const start = doc.y;
  const page = doc.bufferedPageRange().count;
  writeBlocks(
    doc,
    blocks.map((block) =>
      block.type === 'paragraph'
        ? { ...block, inlines: block.inlines.map((run) => ({ ...run, italic: true })) }
        : block
    ),
    inset
  );
  // The rule beside it, when the quote stayed on one page.
  if (doc.bufferedPageRange().count === page) {
    doc
      .moveTo(x + 4, start)
      .lineTo(x + 4, doc.y - 6)
      .lineWidth(2)
      .stroke(RULE);
  }
  doc.x = doc.page.margins.left;
}

function writeRule(doc: Doc): void {
  ensureRoom(doc, 14);
  const y = doc.y + 4;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.75)
    .stroke(RULE);
  doc.y = y + 10;
}

function writeBlocks(doc: Doc, blocks: Block[], x: number = doc.page.margins.left): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        writeHeading(doc, block);
        break;
      case 'paragraph':
        writeParagraph(doc, block.inlines, x, doc.page.width - x - doc.page.margins.right);
        break;
      case 'list':
        writeList(doc, block.ordered, block.start, block.items, 0, x);
        break;
      case 'code':
        writeCode(doc, block.text, x);
        break;
      case 'table':
        writeTable(doc, block, x);
        break;
      case 'quote':
        writeQuote(doc, block.blocks, x);
        break;
      case 'rule':
        writeRule(doc);
        break;
    }
  }
}

function pageNumbers(doc: Doc): void {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    // Writing below the bottom margin would make pdfkit open a fresh page;
    // the footer sits in the margin on purpose, so drop it while writing.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - bottomMargin + 24;
    doc
      .font(FONT.regular)
      .fontSize(9)
      .fillColor(GREY)
      .text(`${index + 1} / ${range.count}`, doc.page.margins.left, y, {
        width: contentWidth(doc),
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottomMargin;
  }
}

export interface PdfOptions {
  title?: string;
}

export async function renderPdf(blocks: Block[], options: PdfOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
    info: { Title: options.title ?? '', Producer: 'Renkei', Creator: 'Renkei' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.font(FONT.regular).fontSize(BODY_SIZE);
  if (blocks.length === 0) doc.text(' ');
  else writeBlocks(doc, blocks);
  pageNumbers(doc);
  doc.end();
  return done;
}
