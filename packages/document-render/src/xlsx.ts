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
 * Excel can sum and sort them; a cell that starts with `=` is a formula
 * (`=SUM(B2:B9)`, `=B2*C2`, `='Q3 Sales'!B4`), written without a cached
 * result and recalculated when the workbook is opened. A leading `'` keeps
 * an `=` as text, as in Excel. The first row is bold and frozen, and
 * columns are sized to their content.
 */

import ExcelJS from 'exceljs';
import { parseMarkdown, plainText, type Block, type Inline } from './markdown-blocks';

export interface Formula {
  /** The formula without its leading `=`, as Excel stores it. */
  formula: string;
}

export type Cell = string | number | boolean | Date | Formula | null;

export function isFormula(cell: Cell): cell is Formula {
  return typeof cell === 'object' && cell !== null && !(cell instanceof Date);
}

export interface Sheet {
  name: string;
  rows: Cell[][];
}

/**
 * What a model needs to know to write formulas, for the description of
 * every tool that renders a workbook from its text.
 */
export const XLSX_FORMULA_GUIDE =
  'A workbook cell that starts with = is a live Excel formula, recalculated when the file is ' +
  'opened: =SUM(B2:B9), =B2*C2, =IF(C2>100,"High","Low"), and other sheets by name, ' +
  "='Q3 Sales'!B4 or =SUM(Detail!C2:C50). Write references for the cells as they will land: " +
  'the first row is row 1, the first column is A; in CSV, quote a formula that holds a comma. ' +
  "Start a cell with '= to keep it as text. Formulas that reach outside the workbook (other " +
  'files, DDE, web calls) are kept as text.';

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

/**
 * Formulas that reach outside the workbook — DDE (`=cmd|' /C calc'!A0`),
 * links to other workbooks (`[Book.xlsx]Sheet!A1`), web calls and macro
 * functions — stay text: the content may be transcribed from a source the
 * model does not vouch for, and a cell that runs something on open is the
 * classic way that goes wrong. Only what is outside string literals counts.
 */
const UNSAFE_FUNCTION =
  /\b(?:WEBSERVICE|FILTERXML|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTRANGE|IMPORTFEED|CALL|REGISTER(?:\.ID)?|EXEC|RTD|DDE)\s*\(/i;

/** The formula a cell's text spells, without its `=`; null when it is text. */
export function formulaOf(text: string): string | null {
  if (!text.startsWith('=') || text.startsWith('==')) return null;
  const formula = text.slice(1).trim();
  if (formula === '') return null;
  const code = formula.replace(/"(?:[^"]|"")*"/g, '""');
  if (/[|[\]]/.test(code) || UNSAFE_FUNCTION.test(code)) return null;
  return formula;
}

/** A text cell as the value Excel should hold. */
export function typedCell(text: string): Cell {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const formula = formulaOf(trimmed);
  if (formula !== null) return { formula };
  if (trimmed.startsWith("'=")) return trimmed.slice(1);
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
  if (isRecord(value) && typeof value.formula === 'string' && Object.keys(value).length === 1) {
    const formula = formulaOf(`=${value.formula.trim().replace(/^=/, '')}`);
    return formula === null ? value.formula : { formula };
  }
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

/**
 * A table cell's value. A formula is read from the cell as written, since
 * Markdown would take the `*` of `=B2*C2*D2` for emphasis.
 */
function markdownCell(cell: Inline[], raw: string | undefined): Cell {
  const written = raw?.replace(/\\\|/g, '|').trim();
  if (written && formulaOf(written) !== null) return typedCell(written);
  return typedCell(plainText(cell));
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
        table.header.map((cell, index) => markdownCell(cell, table.headerRaw[index])),
        ...table.rows.map((row, rowIndex) =>
          row.map((cell, index) => markdownCell(cell, table.rowsRaw[rowIndex]?.[index]))
        ),
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
  // Formulas are written without results; have the reader compute them.
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const sheet of sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }]) {
    const worksheet = workbook.addWorksheet(sheet.name);
    const columns = Math.max(0, ...sheet.rows.map((row) => row.length));
    const widths = Array.from({ length: columns }, () => 8);
    sheet.rows.forEach((row, rowIndex) => {
      const added = worksheet.addRow(row.map((cell) => (cell === null ? null : cell)));
      row.forEach((cell, index) => {
        const length =
          cell instanceof Date || isFormula(cell)
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
