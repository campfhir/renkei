/**
 * The renderers' promises, checked the way a person would: each file is
 * opened again by the platform's own reader (@renkei/document-text) and
 * the words that went in come back out. The block model is checked
 * directly for the shapes that matter to every renderer — nested lists,
 * styled runs, tables, entities undone — and the workbook parser for
 * the three inputs it tells apart.
 */

import { inflateSync } from 'node:zlib';
import { extractText } from '@renkei/document-text';
import { parseMarkdown, plainText } from './markdown-blocks';
import { renderDocument } from './index';
import { parseCsv, sheetsOf, sheetsOfJson, sheetName, typedCell } from './xlsx';
import { splitSlides } from './pptx';
import { undrawableCharacters } from './pdf';

const SAMPLE = `# Quarterly review

An **important** paragraph with *emphasis*, \`code\` and a [link](https://example.com).

## Findings

- First finding
  - A nested point
- Second finding

1. Step one
2. Step two

| Item | Count |
|------|------:|
| Apples | 12 |
| Pears | 3 |

\`\`\`sql
select * from orders where total > 100;
\`\`\`

> A quoted remark.

---

Closing words & an ampersand.
`;

/**
 * The words pdfkit drew, read straight off the page streams: each is
 * inflated and its TJ hex chunks decoded — the platform's own PDF reader
 * needs pdfjs's ESM build, which Jest's CommonJS sandbox cannot load.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const out: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content = match[1]!;
    try {
      content = inflateSync(Buffer.from(content, 'latin1')).toString('latin1');
    } catch {
      // Not a compressed stream; read as is.
    }
    for (const hex of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
      out.push(Buffer.from(hex[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('');
}

async function textOf(bytes: Buffer, fileName: string): Promise<string> {
  const extracted = await extractText(bytes, { fileName, maxChars: 100_000 });
  if (!extracted.ok) throw new Error(`could not read ${fileName}: ${extracted.err.type}`);
  return extracted.val.text;
}

describe('parseMarkdown', () => {
  it('builds the block model with styled runs, nested lists, tables and entities undone', () => {
    const blocks = parseMarkdown(SAMPLE);
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'table',
      'code',
      'quote',
      'rule',
      'paragraph',
    ]);
    const paragraph = blocks[1];
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.inlines).toEqual([
      { text: 'An ' },
      { text: 'important', bold: true },
      { text: ' paragraph with ' },
      { text: 'emphasis', italic: true },
      { text: ', ' },
      { text: 'code', code: true },
      { text: ' and a ' },
      { text: 'link', href: 'https://example.com' },
      { text: '.' },
    ]);
    const list = blocks[3];
    if (list?.type !== 'list') throw new Error('expected a list');
    expect(list.ordered).toBe(false);
    expect(list.items[0]?.children[0]?.type).toBe('list');
    const table = blocks[5];
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.header.map(plainText)).toEqual(['Item', 'Count']);
    expect(table.rows.map((row) => row.map(plainText))).toEqual([
      ['Apples', '12'],
      ['Pears', '3'],
    ]);
    expect(table.align).toEqual([null, 'right']);
    const last = blocks[9];
    if (last?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(plainText(last.inlines)).toBe('Closing words & an ampersand.');
  });

  it('keeps a javascript: link as text and an image as its alt text', () => {
    const [paragraph] = parseMarkdown('[x](javascript:alert(1)) ![a chart](https://e.com/c.png)');
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.inlines).toEqual([{ text: 'x a chart' }]);
  });
});

describe('renderDocument', () => {
  it('writes a Word document the reader opens with every block’s words in it', async () => {
    const rendered = await renderDocument('docx', 'review.docx', SAMPLE);
    expect(rendered.mediaType).toMatch(/wordprocessingml/);
    const text = await textOf(rendered.bytes, 'review.docx');
    for (const words of [
      'Quarterly review',
      'important',
      'A nested point',
      'Step two',
      'Apples',
      'select * from orders',
      'A quoted remark.',
      'Closing words & an ampersand.',
    ]) {
      expect(text).toContain(words);
    }
  });

  it('writes a PDF the reader opens, with page numbers, and notes text its fonts cannot draw', async () => {
    const rendered = await renderDocument('pdf', 'review.pdf', SAMPLE);
    expect(rendered.mediaType).toBe('application/pdf');
    expect(rendered.notes).toEqual([]);
    expect(rendered.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(rendered.bytes.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
    const text = pdfText(rendered.bytes);
    for (const words of [
      'Quarterly review',
      'important',
      'A nested point',
      'Step two',
      'Apples',
      'select * from orders',
      'A quoted remark.',
      'Closing words & an ampersand.',
      '1 / 1',
    ]) {
      expect(text).toContain(words);
    }
    const long = await renderDocument(
      'pdf',
      'long.pdf',
      Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long document.`).join('\n\n')
    );
    const pages = long.bytes.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    expect(pdfText(long.bytes)).toContain(`${pages} / ${pages}`);
    const other = await renderDocument('pdf', 'memo.pdf', 'Καλημέρα κόσμε');
    expect(other.notes[0]).toMatch(/Latin text only/);
    expect(undrawableCharacters('café — “quoted” € 100\n')).toEqual([]);
    expect(undrawableCharacters('naïve 連携')).toEqual(['連', '携']);
  });

  it('writes a deck with a slide per heading, a title slide first', async () => {
    const outline = `# Launch plan\n\nWhere we are.\n\n## Timeline\n\n- Design done\n- Build in progress\n\n## Risks\n\n| Risk | Owner |\n|---|---|\n| Scope | Dana |\n`;
    const slides = splitSlides(parseMarkdown(outline));
    expect(slides.map((slide) => (slide.title ? plainText(slide.title) : null))).toEqual([
      'Launch plan',
      'Timeline',
      'Risks',
    ]);
    const rendered = await renderDocument('pptx', 'plan.pptx', outline);
    expect(rendered.mediaType).toMatch(/presentationml/);
    const text = await textOf(rendered.bytes, 'plan.pptx');
    for (const words of [
      'Launch plan',
      'Where we are.',
      'Timeline',
      'Build in progress',
      'Scope',
      'Dana',
    ]) {
      expect(text).toContain(words);
    }
  });

  it('writes a workbook from CSV, with numbers typed', async () => {
    const rendered = await renderDocument(
      'xlsx',
      'totals.xlsx',
      'name,total,when\n"Ada, A.",12,2026-09-04\nBob,"1,300",\n'
    );
    expect(rendered.mediaType).toMatch(/spreadsheetml/);
    const text = await textOf(rendered.bytes, 'totals.xlsx');
    expect(text).toContain('Ada, A.');
    expect(text).toContain('1300');
  });

  it('writes one sheet per Markdown table and per JSON sheet', async () => {
    const markdown =
      '## North\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## South\n\n| a | b |\n|---|---|\n| 3 | 4 |\n';
    expect(sheetsOf(markdown, 'x').map((sheet) => sheet.name)).toEqual(['North', 'South']);
    const json = JSON.stringify({
      sheets: [
        {
          name: 'Q1',
          rows: [
            ['k', 'v'],
            ['x', 1],
          ],
        },
        { name: 'Q1', columns: ['k'], rows: [{ k: 'y' }] },
      ],
    });
    const sheets = sheetsOf(json, 'x');
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Q1', 'Q1 (2)']);
    expect(sheets[1]?.rows).toEqual([['k'], ['k'], ['y']]);
    const rendered = await renderDocument('xlsx', 'regions.xlsx', markdown);
    const text = await textOf(rendered.bytes, 'regions.xlsx');
    expect(text).toContain('North');
    expect(text).toContain('South');
  });
});

describe('workbook parsing', () => {
  it('reads RFC 4180 CSV and bare TSV', () => {
    expect(parseCsv('a,"b ""q"", c"\n1,2\n\n')).toEqual([
      ['a', 'b "q", c'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\r\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('types cells Excel should hold as values', () => {
    expect(typedCell('12')).toBe(12);
    expect(typedCell('-1,234.5')).toBe(-1234.5);
    expect(typedCell('true')).toBe(true);
    expect(typedCell('2026-09-04')).toEqual(new Date('2026-09-04T00:00:00Z'));
    expect(typedCell('007')).toBe(7);
    expect(typedCell('A12')).toBe('A12');
    expect(typedCell('  ')).toBeNull();
  });

  it('keeps sheet names legal and unique', () => {
    const taken = new Set<string>();
    expect(sheetName('Q3: sales/returns [draft]', taken)).toBe('Q3 sales returns draft');
    expect(sheetName('q3 SALES returns draft', taken)).toBe('q3 SALES returns draft (2)');
    expect(sheetName('x'.repeat(40), taken)).toHaveLength(31);
    expect(sheetsOfJson('{"not":"sheets"}')).toBeNull();
    expect(sheetsOfJson('[{"a":1,"b":"x"},{"a":2,"c":true}]')?.[0]?.rows).toEqual([
      ['a', 'b', 'c'],
      [1, 'x', null],
      [2, null, true],
    ]);
  });
});
