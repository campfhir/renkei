/**
 * A workbook or a CSV as plain grids of strings, for the preview window's
 * tables. Bounded on every axis — a preview is a look, not an export — and
 * each sheet says when it was cut so the window can say so too. Values are
 * what a reader would see: a formula's last result, a date as a date, rich
 * text flattened; never HTML (the window renders them as text nodes).
 */

import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

export const MAX_SHEETS = 10;
export const MAX_ROWS = 500;
export const MAX_COLUMNS = 50;

export interface PreviewSheet {
  name: string;
  rows: string[][];
  /** More rows or columns than were kept. */
  truncated: boolean;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((run) => run.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value) {
      const result = value.result;
      if (result === undefined || result === null) return '';
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      if (typeof result === 'object') return 'error' in result ? String(result.error) : '';
      return String(result);
    }
    if ('error' in value) return String(value.error);
    return '';
  }
  return String(value);
}

export async function sheetsFromXlsx(bytes: Uint8Array): Promise<PreviewSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from([Buffer.from(bytes)]));
  const sheets: PreviewSheet[] = [];
  for (const worksheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
    const rows: string[][] = [];
    let truncated = worksheet.columnCount > MAX_COLUMNS;
    worksheet.eachRow({ includeEmpty: true }, (row, number) => {
      if (number > MAX_ROWS) {
        truncated = true;
        return;
      }
      const cells: string[] = [];
      for (let column = 1; column <= Math.min(worksheet.columnCount, MAX_COLUMNS); column++) {
        cells.push(cellText(row.getCell(column).value));
      }
      rows.push(cells);
    });
    sheets.push({ name: worksheet.name, rows, truncated });
  }
  return sheets;
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, a quoted newline kept. */
export function sheetFromCsv(text: string, name: string): PreviewSheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index++) {
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
      rows.push(row);
      row = [];
      if (rows.length >= MAX_ROWS) {
        truncated = index < source.length - 1;
        break;
      }
    } else {
      field += char;
    }
  }
  if (!truncated && (field !== '' || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  const clipped = rows.map((cells) => {
    if (cells.length > MAX_COLUMNS) truncated = true;
    return cells.slice(0, MAX_COLUMNS);
  });
  return { name, rows: clipped, truncated };
}
