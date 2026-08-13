/**
 * Excel (.xlsx) text.
 *
 * The design question here is not parsing, it is SERIALIZATION, and getting it
 * wrong makes the output worthless without looking wrong. A pipe-delimited
 * table chunked at 2000 characters gives chunk 2 onward rows like
 * `EMEA | Widget A | 1200 | 48000` with no idea what the columns mean — the
 * header lives in chunk 1 and nowhere else, so every later chunk is
 * semantically dead weight in the index.
 *
 * So a sheet that looks tabular (a string-typed first row, at least two data
 * rows) is emitted as key-value rows instead:
 *
 *     ## Sheet: Q4 Forecast
 *     Region: EMEA · Product: Widget A · Units: 1200 · Revenue: 48000
 *
 * Every row now stands alone regardless of where the chunker cuts. It costs
 * roughly 2-3x the characters, which the budget bounds, and a chunk that
 * cannot be interpreted is worth zero at any size.
 *
 * Known limitation, stated rather than hidden: dates are stored as serial
 * numbers, so a date column extracts as `46246`. Fixing it means reading
 * styles.xml and mapping numFmtIds — worth doing, deliberately not in v1.
 */

import { scanXml, attribute } from './xml';
import { TextBudget } from './types';

export const XLSX_PARTS =
  /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml)$/;

interface SheetRef {
  name: string;
  /** relationship id → resolved through workbook.xml.rels to a part name. */
  relationId: string;
  hidden: boolean;
}

/** Shared strings are an index; `si` may hold one `t` or many rich-text runs. */
function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  let current = '';
  let depth = 0;
  let inText = false;
  // Phonetic (furigana) runs duplicate the text they annotate.
  let inPhonetic = false;

  scanXml(xml, {
    onOpen: (tag) => {
      if (tag.name === 'si') {
        depth += 1;
        current = '';
      } else if (tag.name === 'rPh') inPhonetic = true;
      else if (tag.name === 't' && depth > 0) inText = true;
    },
    onClose: (name) => {
      if (name === 'si') {
        strings.push(current);
        depth -= 1;
      } else if (name === 'rPh') inPhonetic = false;
      else if (name === 't') inText = false;
    },
    onText: (text) => {
      if (inText && !inPhonetic) current += text;
    },
  });
  return strings;
}

function readSheetRefs(xml: string | undefined): SheetRef[] {
  if (!xml) return [];
  const sheets: SheetRef[] = [];
  scanXml(xml, {
    onOpen: (tag) => {
      if (tag.name !== 'sheet') return;
      const state = attribute(tag.attributes, 'state');
      sheets.push({
        name: attribute(tag.attributes, 'name') ?? '',
        relationId: attribute(tag.attributes, 'r:id') ?? '',
        // Hidden sheets are lookup tables and scratch space, near-universally
        // noise rather than content.
        hidden: state === 'hidden' || state === 'veryHidden',
      });
    },
  });
  return sheets;
}

/** relationship id → part name, so sheet order follows the workbook, not filenames. */
function readRelationships(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  scanXml(xml, {
    onOpen: (tag) => {
      if (tag.name !== 'Relationship') return;
      const id = attribute(tag.attributes, 'Id');
      const target = attribute(tag.attributes, 'Target');
      if (!id || !target) return;
      const normalized = target.replace(/^\/?(xl\/)?/, '');
      map.set(id, `xl/${normalized}`);
    },
  });
  return map;
}

/** Rows of non-empty cell values, in column order. */
function readRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellType = '';
  let inValue = false;
  let inInline = false;
  let value = '';

  const flushCell = () => {
    if (!value) return;
    if (cellType === 's') {
      const index = Number.parseInt(value, 10);
      const resolved = Number.isFinite(index) ? shared[index] : undefined;
      if (resolved) row.push(resolved);
    } else if (cellType === 'e') {
      // #REF!, #N/A — an error is not information.
    } else if (cellType === 'b') {
      row.push(value === '1' ? 'TRUE' : 'FALSE');
    } else {
      row.push(value);
    }
    value = '';
  };

  scanXml(xml, {
    onOpen: (tag) => {
      switch (tag.name) {
        case 'row':
          row = [];
          break;
        case 'c':
          cellType = attribute(tag.attributes, 't') ?? '';
          value = '';
          break;
        case 'v':
          inValue = true;
          break;
        case 'is':
          inInline = true;
          break;
        case 't':
          if (inInline) inValue = true;
          break;
        default:
          break;
      }
    },
    onClose: (name) => {
      switch (name) {
        case 'v':
          inValue = false;
          break;
        case 't':
          if (inInline) inValue = false;
          break;
        case 'is':
          inInline = false;
          break;
        case 'c':
          flushCell();
          break;
        case 'row':
          if (row.length > 0) rows.push(row);
          break;
        default:
          break;
      }
    },
    onText: (text) => {
      // `f` (the formula) is never captured: SUM(B2:B40) is not something
      // anyone will semantically search for. Only `v` and inline `t` are read.
      if (inValue) value += text;
    },
  });

  return rows;
}

/** A header row plus at least two data rows means the key-value form pays off. */
function looksTabular(rows: string[][]): boolean {
  if (rows.length < 3) return false;
  const header = rows[0]!;
  if (header.length < 2) return false;
  return header.every((cell) => cell.trim() !== '' && !/^-?\d+(\.\d+)?$/.test(cell.trim()));
}

export function extractXlsx(parts: Map<string, Uint8Array>, budget: TextBudget): number {
  const decoder = new TextDecoder('utf-8');
  const read = (name: string): string | undefined => {
    const bytes = parts.get(name);
    return bytes ? decoder.decode(bytes) : undefined;
  };

  const shared = readSharedStrings(read('xl/sharedStrings.xml'));
  const relationships = readRelationships(read('xl/_rels/workbook.xml.rels'));
  const sheets = readSheetRefs(read('xl/workbook.xml'));
  let emitted = 0;

  for (const sheet of sheets) {
    if (sheet.hidden || budget.spent) continue;
    // sheet1.xml is not necessarily the first sheet — resolve through the
    // relationship, or the output silently reorders the workbook.
    const partName = relationships.get(sheet.relationId);
    const xml = partName ? read(partName) : undefined;
    if (!xml) continue;

    const rows = readRows(xml, shared);
    if (rows.length === 0) continue;

    budget.push(`\n## Sheet: ${sheet.name}\n\n`);
    emitted += 1;

    if (looksTabular(rows)) {
      const header = rows[0]!;
      for (const dataRow of rows.slice(1)) {
        if (budget.spent) break;
        const pairs = dataRow
          .map((cell, index) => (cell ? `${header[index] ?? `Column ${index + 1}`}: ${cell}` : ''))
          .filter(Boolean);
        if (pairs.length > 0) budget.push(`${pairs.join(' · ')}\n`);
      }
    } else {
      for (const dataRow of rows) {
        if (budget.spent) break;
        budget.push(`${dataRow.join(' · ')}\n`);
      }
    }
  }

  return emitted;
}
