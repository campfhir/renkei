import ExcelJS from 'exceljs';
import { MAX_COLUMNS, MAX_ROWS, sheetFromCsv, sheetFromXlsx } from './sheet-preview';

describe('sheetFromCsv', () => {
  it('splits quoted fields, doubled quotes, CRLF and a quoted newline; numbers set right', () => {
    const sheet = sheetFromCsv('\uFEFFname,amount\r\n"Smith, J","1,200.50"\nLee "x",7%\n', 'x.csv');
    expect(sheet.rows).toEqual([
      [{ v: 'name' }, { v: 'amount' }],
      [{ v: 'Smith, J' }, { v: '1,200.50', n: true }],
      [{ v: 'Lee "x"' }, { v: '7%', n: true }],
    ]);
    expect(sheet.sheetCount).toBe(1);
    expect(sheet.widths).toHaveLength(2);
  });

  it('reads only the corner that is drawn', () => {
    const wide = Array.from({ length: MAX_COLUMNS + 5 }, (_, index) => `c${index}`).join(',');
    const csv = Array.from({ length: MAX_ROWS + 5 }, () => wide).join('\n');
    const sheet = sheetFromCsv(csv, 'x.csv');
    expect(sheet.rows).toHaveLength(MAX_ROWS);
    expect(sheet.rows[0]).toHaveLength(MAX_COLUMNS);
  });
});

describe('sheetFromXlsx', () => {
  it('reads the first sheet as a reader would see it: values, bold, numbers, widths', async () => {
    const workbook = new ExcelJS.Workbook();
    const sales = workbook.addWorksheet('Sales');
    sales.getColumn(1).width = 20;
    sales.addRow(['Region', 'Units', 'Total', 'When']).font = { bold: true };
    sales.addRow(['EMEA', 12, { formula: 'B2*2', result: 24 }, new Date('2026-09-30T00:00:00Z')]);
    sales.addRow([{ richText: [{ text: 'bold ' }, { text: 'plain' }] }]);
    workbook.addWorksheet('Notes').addRow(['not drawn']);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const sheet = await sheetFromXlsx(bytes);
    expect(sheet).not.toBeNull();
    expect(sheet!.name).toBe('Sales');
    expect(sheet!.sheetCount).toBe(2);
    expect(sheet!.rows[0][0]).toEqual({ v: 'Region', b: true });
    expect(sheet!.rows[1]).toEqual([
      { v: 'EMEA' },
      { v: '12', n: true },
      { v: '24', n: true },
      { v: '2026-09-30', n: true },
    ]);
    expect(sheet!.rows[2][0]).toEqual({ v: 'bold plain' });
    expect(sheet!.widths[0]).toBe(20);
    expect(sheet!.widths[1]).toBeCloseTo(8.43);
  });

  it('shows a formula never computed (a workbook we wrote) as the formula', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('S').addRow([2, { formula: 'A1*3' }]);
    const sheet = await sheetFromXlsx(new Uint8Array(await workbook.xlsx.writeBuffer()));
    expect(sheet!.rows[0]).toEqual([{ v: '2', n: true }, { v: '=A1*3' }]);
  });
});
