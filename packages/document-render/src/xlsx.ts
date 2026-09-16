/**
 * Text → a workbook, with exceljs. The model can hand over the data three
 * ways, told apart by looking, never by a flag it might get wrong:
 *
 * - JSON: `{"sheets":[{"name":"Q3","rows":[["Name","Total"],["Ada",12]]}]}`,
 *   or a bare array of rows, or an array of objects (keys become the
 *   header). This is the form for more than one sheet.
 * - Markdown: every table becomes a sheet, named by the heading before it.
 * - CSV: anything else, one sheet, RFC 4180 quoting honored.
 *
 * Cells that read as numbers, booleans or ISO dates are typed as such so
 * Excel can sum and sort them; the first row is bold and frozen, and
 * columns are sized to their content.
 */

import ExcelJS from 'exceljs';
import { parseMarkdown, plainText, type Block } from './markdown-blocks';

export type Cell = string | number | boolean | Date | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

const SHEET_NAME_MAX = 31;
const MAX_COLUMN_WIDTH = 60;

/** Excel's rules for a sheet name: 31 chars, none of []:*?/\, unique. */
export function sheetName(raw: string, taken: Set<string>): string {
  let base =
    raw
      .replace(/[[\]:*?/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SHEET_NAME_MAX) || 'Sheet';
  let name = base;
  let counter = 2;
  while (taken.has(name.toLowerCase())) {
    const suffix = ` (${counter})`;
    base = base.slice(0, SHEET_NAME_MAX - suffix.length);
    name = `${base}${suffix}`;
    counter += 1;
  }
  taken.add(name.toLowerCase());
  return name;
}

const NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A text cell as the value Excel should hold. */
export function typedCell(text: string): Cell {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (NUMBER.test(trimmed)) {
    const value = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) return value;
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (ISO_DATE.test(trimmed)) {
    const date = new Date(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return text;
}

/** RFC 4180 CSV → rows of text; a bare tab-separated file is taken as such. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/\r\n?/g, '\n');
  const firstLine = source.slice(0, source.indexOf('\n') === -1 ? undefined : source.indexOf('\n'));
  const delimiter = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRowArray(value: unknown[]): value is unknown[][] {
  return value.every((row) => Array.isArray(row));
}

function isRecordArray(value: unknown[]): value is Record<string, unknown>[] {
  return value.every(isRecord);
}

function cellOfJson(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return typedCell(value);
  return JSON.stringify(value);
}

function rowsOfJson(value: unknown): Cell[][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (isRowArray(value)) return value.map((row) => row.map(cellOfJson));
  if (isRecordArray(value)) {
    const keys: string[] = [];
    for (const record of value) {
      for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key);
    }
    return [keys, ...value.map((record) => keys.map((key) => cellOfJson(record[key])))];
  }
  return null;
}

/** The sheets a JSON body describes, or null when it is not that shape. */
export function sheetsOfJson(text: string): Sheet[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const taken = new Set<string>();
  if (isRecord(parsed)) {
    if (!Array.isArray(parsed.sheets)) return null;
    const sheets: Sheet[] = [];
    for (const entry of parsed.sheets) {
      if (!isRecord(entry)) return null;
      const rows = rowsOfJson(entry.rows) ?? [];
      const columns = Array.isArray(entry.columns) ? entry.columns.map(cellOfJson) : null;
      sheets.push({
        name: sheetName(
          typeof entry.name === 'string' ? entry.name : `Sheet${sheets.length + 1}`,
          taken
        ),
        rows: columns ? [columns, ...rows] : rows,
      });
    }
    return sheets.length > 0 ? sheets : null;
  }
  const rows = rowsOfJson(parsed);
  return rows ? [{ name: sheetName('Sheet1', taken), rows }] : null;
}

/** One sheet per Markdown table, named by the heading before it; null without tables. */
export function sheetsOfMarkdown(text: string): Sheet[] | null {
  if (!/^\s*\|.*\|\s*$/m.test(text)) return null;
  const blocks = parseMarkdown(text);
  if (!blocks.some((block) => block.type === 'table')) return null;
  const taken = new Set<string>();
  const sheets: Sheet[] = [];
  let heading: string | null = null;
  for (const block of blocks) {
    if (block.type === 'heading') heading = plainText(block.inlines).trim() || null;
    if (block.type !== 'table') continue;
    const table: Extract<Block, { type: 'table' }> = block;
    sheets.push({
      name: sheetName(heading ?? `Sheet${sheets.length + 1}`, taken),
      rows: [
        table.header.map((cell) => typedCell(plainText(cell))),
        ...table.rows.map((row) => row.map((cell) => typedCell(plainText(cell)))),
      ],
    });
    heading = null;
  }
  return sheets;
}

export function sheetsOfCsv(text: string, name: string): Sheet[] {
  const rows = parseCsv(text).map((row) => row.map(typedCell));
  return [{ name: sheetName(name, new Set()), rows }];
}

/** Whatever the text is — JSON sheets, Markdown tables, or CSV — as sheets. */
export function sheetsOf(text: string, defaultName: string): Sheet[] {
  return sheetsOfJson(text) ?? sheetsOfMarkdown(text) ?? sheetsOfCsv(text, defaultName);
}

export async function renderXlsx(sheets: Sheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Renkei';
  workbook.created = new Date();
  for (const sheet of sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }]) {
    const worksheet = workbook.addWorksheet(sheet.name);
    const columns = Math.max(0, ...sheet.rows.map((row) => row.length));
    const widths = Array.from({ length: columns }, () => 8);
    sheet.rows.forEach((row, rowIndex) => {
      const added = worksheet.addRow(row.map((cell) => (cell === null ? null : cell)));
      row.forEach((cell, index) => {
        const length =
          cell instanceof Date
            ? 10
            : cell === null
              ? 0
              : String(cell).length + (rowIndex === 0 ? 2 : 0);
        widths[index] = Math.min(MAX_COLUMN_WIDTH, Math.max(widths[index] ?? 8, length + 2));
        if (cell instanceof Date) added.getCell(index + 1).numFmt = 'yyyy-mm-dd';
      });
    });
    widths.forEach((width, index) => {
      worksheet.getColumn(index + 1).width = width;
    });
    if (sheet.rows.length > 0) {
      worksheet.getRow(1).font = { bold: true };
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
  }
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
