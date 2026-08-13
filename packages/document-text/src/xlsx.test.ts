/**
 * Excel extraction. The serialization tests matter most: they are the
 * difference between chunks that can be retrieved and chunks that cannot.
 */

import { extractText } from './index';
import { buildZip } from './test-support';

interface SheetSpec {
  name: string;
  rows: string[][];
  hidden?: boolean;
}

/** Build an xlsx with inline strings, so no sharedStrings indirection. */
function buildXlsx(sheets: SheetSpec[]): Uint8Array {
  const files: Record<string, string> = {
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns:r="r"><sheets>' +
      sheets
        .map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"${
              sheet.hidden ? ' state="hidden"' : ''
            }/>`
        )
        .join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships>' +
      sheets
        .map(
          (_sheet, index) =>
            `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`
        )
        .join('') +
      '</Relationships>',
  };

  sheets.forEach((sheet, index) => {
    const rows = sheet.rows
      .map(
        (row) =>
          '<row>' +
          row
            .map((cell) =>
              cell === ''
                ? ''
                : /^-?\d+(\.\d+)?$/.test(cell)
                  ? `<c><v>${cell}</v></c>`
                  : `<c t="inlineStr"><is><t>${cell}</t></is></c>`
            )
            .join('') +
          '</row>'
      )
      .join('');
    files[`xl/worksheets/sheet${index + 1}.xml`] =
      `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });

  return buildZip(files);
}

const textOf = async (bytes: Uint8Array): Promise<string> => {
  const result = await extractText(bytes);
  if (!result.ok) throw new Error(`extraction failed: ${result.err.type}`);
  return result.val.text;
};

describe('xlsx extraction', () => {
  it('labels each row with its column header so a chunk stands alone', async () => {
    // The whole point: chunk 2 of a long table must still be interpretable,
    // and a bare `EMEA | Widget A | 1200` is not.
    const text = await textOf(
      buildXlsx([
        {
          name: 'Q4 Forecast',
          rows: [
            ['Region', 'Product', 'Units'],
            ['EMEA', 'Widget A', '1200'],
            ['APAC', 'Widget A', '940'],
          ],
        },
      ])
    );
    expect(text).toContain('## Sheet: Q4 Forecast');
    expect(text).toContain('Region: EMEA · Product: Widget A · Units: 1200');
    expect(text).toContain('Region: APAC · Product: Widget A · Units: 940');
  });

  it('falls back to plain rows when a sheet is not tabular', async () => {
    // A single-column sheet has no header to label anything with, so forcing
    // the key-value form would invent structure that is not there.
    const text = await textOf(
      buildXlsx([{ name: 'Notes', rows: [['Just a note'], ['Another note']] }])
    );
    expect(text).toContain('Just a note');
    expect(text).toContain('Another note');
    expect(text).not.toContain('Just a note: ');
  });

  it('skips hidden sheets, which are lookup tables rather than content', async () => {
    const text = await textOf(
      buildXlsx([
        { name: 'Visible', rows: [['Alpha']] },
        { name: 'Lookups', rows: [['SECRET-CODE']], hidden: true },
      ])
    );
    expect(text).toContain('Alpha');
    expect(text).not.toContain('SECRET-CODE');
  });

  it('follows workbook order, not sheet filename order', async () => {
    // sheet1.xml is not necessarily the first sheet; resolving through the
    // relationship is what keeps the output in the workbook's own order.
    const bytes = buildZip({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="r"><sheets>' +
        '<sheet name="Second" sheetId="1" r:id="rA"/>' +
        '<sheet name="First" sheetId="2" r:id="rB"/>' +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships>' +
        '<Relationship Id="rA" Target="worksheets/sheet2.xml"/>' +
        '<Relationship Id="rB" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
      'xl/worksheets/sheet1.xml':
        '<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>I am first</t></is></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':
        '<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>I am second</t></is></c></row></sheetData></worksheet>',
    });
    const text = await textOf(bytes);
    expect(text.indexOf('Second')).toBeLessThan(text.indexOf('First'));
  });

  it('resolves shared strings, including rich-text runs, without phonetics', async () => {
    const bytes = buildZip({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<?xml version="1.0"?><sst>' +
        '<si><r><t>Total </t></r><r><t>revenue</t></r><rPh><t>furigana</t></rPh></si>' +
        '</sst>',
      'xl/worksheets/sheet1.xml':
        '<?xml version="1.0"?><worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
    });
    const text = await textOf(bytes);
    expect(text).toContain('Total revenue');
    // Phonetic annotations duplicate the text they annotate.
    expect(text).not.toContain('furigana');
  });

  it('skips error cells and formulas, keeping cached results', async () => {
    const bytes = buildZip({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<?xml version="1.0"?><worksheet><sheetData><row>' +
        '<c t="e"><v>#REF!</v></c>' +
        '<c><f>SUM(B2:B40)</f><v>4200</v></c>' +
        '</row></sheetData></worksheet>',
    });
    const text = await textOf(bytes);
    expect(text).toContain('4200');
    expect(text).not.toContain('#REF!');
    expect(text).not.toContain('SUM');
  });

  it('reports the sheet count', async () => {
    const result = await extractText(
      buildXlsx([
        { name: 'A', rows: [['x']] },
        { name: 'B', rows: [['y']] },
      ])
    );
    expect(result.ok && result.val.sections).toBe(2);
  });
});
