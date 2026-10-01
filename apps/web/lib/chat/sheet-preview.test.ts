import ExcelJS from 'exceljs';
import { MAX_ROWS, sheetFromCsv, sheetsFromXlsx } from './sheet-preview';

describe('sheetFromCsv', () => {
  it('splits quoted fields, doubled quotes, CRLF and a quoted newline', () => {
    const sheet = sheetFromCsv(
      '﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\nLee,ok',
      'x.csv'
    );
    expect(sheet.rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\nthen left'],
      ['Lee', 'ok'],
    ]);
    expect(sheet.truncated).toBe(false);
  });

  it('stops at the row limit and says so', () => {
    const csv = Array.from({ length: MAX_ROWS + 5 }, (_, index) => `r${index}`).join('\n');
    const sheet = sheetFromCsv(csv, 'x.csv');
    expect(sheet.rows).toHaveLength(MAX_ROWS);
    expect(sheet.truncated).toBe(true);
  });
});

describe('sheetsFromXlsx', () => {
  it('reads every sheet as the strings a reader would see', async () => {
    const workbook = new ExcelJS.Workbook();
    const sales = workbook.addWorksheet('Sales');
    sales.addRow(['Region', 'Units', 'Total', 'When']);
    sales.addRow(['EMEA', 12, { formula: 'B2*2', result: 24 }, new Date('2026-09-30T00:00:00Z')]);
    workbook.addWorksheet('Notes').addRow([{ richText: [{ text: 'bold ' }, { text: 'plain' }] }]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const sheets = await sheetsFromXlsx(bytes);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Notes']);
    expect(sheets[0].rows).toEqual([
      ['Region', 'Units', 'Total', 'When'],
      ['EMEA', '12', '24', '2026-09-30'],
    ]);
    expect(sheets[1].rows).toEqual([['bold plain']]);
    expect(sheets[0].truncated).toBe(false);
  });
});
