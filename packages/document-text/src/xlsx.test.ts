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

/** Column index (0-based) → Excel letters: 0 → A, 25 → Z, 26 → AA. */
function columnLetters(index: number): string {
  let letters = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Build an xlsx with inline strings, so no sharedStrings indirection. Shaped
 * the way Excel writes a sheet: every cell carries its `r="D3"` address and a
 * blank cell is simply absent from the XML, so a reader that ignores `r`
 * slides every later value one column left.
 */
function buildXlsx(sheets: SheetSpec[], options: { addresses?: boolean } = {}): Uint8Array {
  const addresses = options.addresses ?? true;
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
      .map((row, rowIndex) => {
        const rowAttr = addresses ? ` r="${rowIndex + 1}"` : '';
        return (
          `<row${rowAttr}>` +
          row
            .map((cell, columnIndex) => {
              if (cell === '') return '';
              const ref = addresses ? ` r="${columnLetters(columnIndex)}${rowIndex + 1}"` : '';
              return /^-?\d+(\.\d+)?$/.test(cell)
                ? `<c${ref}><v>${cell}</v></c>`
                : `<c${ref} t="inlineStr"><is><t>${cell}</t></is></c>`;
            })
            .join('') +
          '</row>'
        );
      })
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

  it('keeps a value under its own header when an earlier cell in the row is blank', async () => {
    // The GenServe case: a patient with no home phone must not have their
    // mobile number land under "Home Phone", nor every later column slide
    // left by one. Excel omits blank cells from the XML, so position comes
    // from the cell address, not from counting <c> elements.
    const text = await textOf(
      buildXlsx([
        {
          name: 'Outreach',
          rows: [
            ['MRN', 'Patient', 'Home Phone', 'Mobile Phone', 'MyChart', 'Language'],
            ['1001', 'Ada Lovelace', '415-555-0100', '415-555-0101', 'Active', 'English'],
            ['1002', 'Grace Hopper', '', '415-555-0202', '', 'Cantonese'],
            ['1003', 'Mary Jackson', '', '', 'Inactive', ''],
          ],
        },
      ])
    );
    expect(text).toContain(
      'MRN: 1002 · Patient: Grace Hopper · Mobile Phone: 415-555-0202 · Language: Cantonese'
    );
    expect(text).toContain('MRN: 1003 · Patient: Mary Jackson · MyChart: Inactive');
    // The exact mislabelings the collapse produces.
    expect(text).not.toContain('Home Phone: 415-555-0202');
    expect(text).not.toContain('MyChart: Cantonese');
    expect(text).not.toContain('Home Phone: Inactive');
  });

  it('keeps alignment when a blank cell is present but valueless', async () => {
    // A styled-but-empty cell is written as `<c r="C2" s="3"/>` — present,
    // no <v>. It must hold its column open exactly like an absent cell.
    const bytes = buildZip({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<?xml version="1.0"?><sst><si><t></t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c><c r="B1" t="inlineStr"><is><t>B</t></is></c><c r="C1" t="inlineStr"><is><t>C</t></is></c><c r="D1" t="inlineStr"><is><t>D</t></is></c></row>' +
        '<row r="2"><c r="A2"><v>1</v></c><c r="B2" s="3"/><c r="C2" t="s"><v>0</v></c><c r="D2"><v>4</v></c></row>' +
        '<row r="3"><c r="A3"><v>1</v></c><c r="B3" t="e"><v>#N/A</v></c><c r="C3"><v>3</v></c><c r="D3"><v>4</v></c></row>' +
        '<row r="4"><c r="A4"><v>1</v></c><c r="B4"><v>2</v></c><c r="C4"><v>3</v></c><c r="D4"><v>4</v></c></row>' +
        '</sheetData></worksheet>',
    });
    const text = await textOf(bytes);
    expect(text).toContain('A: 1 · D: 4\n');
    expect(text).toContain('A: 1 · C: 3 · D: 4\n');
    expect(text).toContain('A: 1 · B: 2 · C: 3 · D: 4');
    expect(text).not.toContain('B: 4');
    expect(text).not.toContain('B: 3');
  });

  it('still reads a sheet whose cells carry no addresses, in document order', async () => {
    // `r` is optional in the spec; a writer that omits it lays cells out
    // consecutively, and that is the only position information there is.
    const text = await textOf(
      buildXlsx(
        [
          {
            name: 'Plain',
            rows: [
              ['Region', 'Units'],
              ['EMEA', '12'],
              ['APAC', '9'],
            ],
          },
        ],
        { addresses: false }
      )
    );
    expect(text).toContain('Region: EMEA · Units: 12');
    expect(text).toContain('Region: APAC · Units: 9');
  });

  it('labels a column whose header cell is blank rather than abandoning the table', async () => {
    // A blank header cell previously made the header "collapse" so the row
    // still looked fully labelled; held open, it needs a stand-in label.
    const text = await textOf(
      buildXlsx([
        {
          name: 'Gap',
          rows: [
            ['MRN', '', 'Provider'],
            ['1', 'x', 'Dr A'],
            ['2', 'y', 'Dr B'],
          ],
        },
      ])
    );
    expect(text).toContain('MRN: 1 · Column 2: x · Provider: Dr A');
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

  it('reads a formula with no cached result as the formula', async () => {
    const bytes = buildZip({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<?xml version="1.0"?><worksheet><sheetData><row>' +
        '<c><v>7</v></c>' +
        '<c><f>A1*2</f></c>' +
        '</row></sheetData></worksheet>',
    });
    const text = await textOf(bytes);
    expect(text).toContain('7');
    expect(text).toContain('=A1*2');
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
