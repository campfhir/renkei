/**
 * The first sheet of a workbook, or a CSV, as the corner of a spreadsheet
 * the thread draws in place of the file: the top-left window of cells,
 * with what makes a sheet read as one — column widths, bold, numbers set
 * right. Only that corner is ever drawn, so only that corner is read.
 * Values are what a reader would see: a formula's last result (the formula
 * itself when it was never computed — a workbook we wrote), a date as a date, rich text flattened; never HTML (the thread renders text nodes).
 */

import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

export const MAX_ROWS = 40;
export const MAX_COLUMNS = 15;
/** Excel's default column width, in characters. */
const DEFAULT_WIDTH = 8.43;

export interface PreviewCell {
  v: string;
  /** Bold in the file. */
  b?: true;
  /** A number (or a date): set right, as a spreadsheet does. */
  n?: true;
}

export interface PreviewSheet {
  name: string;
  rows: PreviewCell[][];
  /** Each column's width, in Excel's character units. */
  widths: number[];
  /** How many sheets the file has; only the first is drawn. */
  sheetCount: number;
}

function cellOf(value: ExcelJS.CellValue): PreviewCell {
  if (value === null || value === undefined) return { v: '' };
  if (value instanceof Date) return { v: value.toISOString().slice(0, 10), n: true };
  if (typeof value === 'number') return { v: String(value), n: true };
  if (typeof value === 'object') {
    if ('richText' in value) return { v: value.richText.map((run) => run.text).join('') };
    if ('text' in value && typeof value.text === 'string') return { v: value.text };
    if ('formula' in value || 'sharedFormula' in value || 'result' in value) {
      const result = 'result' in value ? value.result : undefined;
      if (result === undefined || result === null) {
        const formula = 'formula' in value ? value.formula : undefined;
        return { v: formula ? `=${formula}` : '' };
      }
      if (result instanceof Date) return { v: result.toISOString().slice(0, 10), n: true };
      if (typeof result === 'number') return { v: String(result), n: true };
      if (typeof result === 'object') return { v: 'error' in result ? String(result.error) : '' };
      return { v: String(result) };
    }
    if ('error' in value) return { v: String(value.error) };
    return { v: '' };
  }
  return { v: String(value) };
}

export async function sheetFromXlsx(bytes: Uint8Array): Promise<PreviewSheet | null> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from([Buffer.from(bytes)]));
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return null;
  const columns = Math.max(1, Math.min(worksheet.columnCount, MAX_COLUMNS));
  const rows: PreviewCell[][] = [];
  const last = Math.min(worksheet.rowCount, MAX_ROWS);
  for (let number = 1; number <= last; number++) {
    const row = worksheet.getRow(number);
    const cells: PreviewCell[] = [];
    for (let column = 1; column <= columns; column++) {
      const cell = row.getCell(column);
      const shown = cellOf(cell.value);
      cells.push(cell.font?.bold ? { ...shown, b: true } : shown);
    }
    rows.push(cells);
  }
  const widths = Array.from(
    { length: columns },
    (_, index) => worksheet.getColumn(index + 1).width ?? DEFAULT_WIDTH
  );
  return { name: worksheet.name, rows, widths, sheetCount: workbook.worksheets.length };
}

const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, a quoted newline kept. */
export function sheetFromCsv(text: string, name: string): PreviewSheet {
  const grid: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length && grid.length < MAX_ROWS; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(field);
      field = '';
      grid.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (grid.length < MAX_ROWS && (field !== '' || row.length > 0)) {
    row.push(field);
    grid.push(row);
  }
  const columns = Math.max(
    1,
    Math.min(Math.max(0, ...grid.map((cells) => cells.length)), MAX_COLUMNS)
  );
  const rows = grid.map((cells) =>
    Array.from({ length: columns }, (_, index): PreviewCell => {
      const value = cells[index] ?? '';
      return value !== '' && NUMERIC.test(value.trim()) ? { v: value, n: true } : { v: value };
    })
  );
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.min(40, Math.max(DEFAULT_WIDTH, ...rows.map((cells) => cells[index].v.length + 1)))
  );
  return { name, rows, widths, sheetCount: 1 };
}
