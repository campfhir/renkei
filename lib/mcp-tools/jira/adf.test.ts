import { adfToMarkdown, isEmptyAdf } from './adf';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const item = (...content: unknown[]) => ({ type: 'listItem', content });

describe('adfToMarkdown', () => {
  it('reads a plain paragraph', () => {
    expect(adfToMarkdown(doc(paragraph(text('Change approved by CAB.'))))).toBe(
      'Change approved by CAB.'
    );
  });

  it('separates blocks with a blank line', () => {
    expect(adfToMarkdown(doc(paragraph(text('First.')), paragraph(text('Second.'))))).toBe(
      'First.\n\nSecond.'
    );
  });

  it('applies marks, with code suppressing emphasis', () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text('bold', [{ type: 'strong' }]),
            text(' '),
            text('italic', [{ type: 'em' }]),
            text(' '),
            text('gone', [{ type: 'strike' }])
          )
        )
      )
    ).toBe('**bold** *italic* ~~gone~~');

    // Emphasis inside a code span would be literal, so it is dropped.
    expect(adfToMarkdown(doc(paragraph(text('x', [{ type: 'code' }, { type: 'strong' }]))))).toBe(
      '`x`'
    );
  });

  it('wraps a marked run in its link', () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text('the RFC', [
              { type: 'strong' },
              { type: 'link', attrs: { href: 'https://x.test' } },
            ])
          )
        )
      )
    ).toBe('[**the RFC**](https://x.test)');
  });

  it('renders a hard break inside one paragraph', () => {
    expect(
      adfToMarkdown(doc(paragraph(text('line one'), { type: 'hardBreak' }, text('line two'))))
    ).toBe('line one\nline two');
  });

  it('clamps heading levels into range', () => {
    expect(
      adfToMarkdown(doc({ type: 'heading', attrs: { level: 3 }, content: [text('Plan')] }))
    ).toBe('### Plan');
    expect(
      adfToMarkdown(doc({ type: 'heading', attrs: { level: 99 }, content: [text('Deep')] }))
    ).toBe('###### Deep');
  });

  it('nests lists on the following line, not after a blank one', () => {
    const node = doc({
      type: 'bulletList',
      content: [
        item(paragraph(text('outer'))),
        item(paragraph(text('with children')), {
          type: 'bulletList',
          content: [item(paragraph(text('inner')))],
        }),
      ],
    });
    expect(adfToMarkdown(node)).toBe('- outer\n- with children\n  - inner');
  });

  it('numbers ordered lists from their start attribute', () => {
    const node = doc({
      type: 'orderedList',
      attrs: { order: 3 },
      content: [item(paragraph(text('third'))), item(paragraph(text('fourth')))],
    });
    expect(adfToMarkdown(node)).toBe('3. third\n4. fourth');
  });

  it('marks task list state', () => {
    const node = doc({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('backup taken')] },
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('notify stakeholders')] },
      ],
    });
    expect(adfToMarkdown(node)).toBe('- [x] backup taken\n- [ ] notify stakeholders');
  });

  it('fences code blocks with their language', () => {
    const node = doc({
      type: 'codeBlock',
      attrs: { language: 'sql' },
      content: [text('select 1;')],
    });
    expect(adfToMarkdown(node)).toBe('```sql\nselect 1;\n```');
  });

  it('quotes blockquotes and labels panels', () => {
    expect(adfToMarkdown(doc({ type: 'blockquote', content: [paragraph(text('quoted'))] }))).toBe(
      '> quoted'
    );
    expect(
      adfToMarkdown(
        doc({
          type: 'panel',
          attrs: { panelType: 'warning' },
          content: [paragraph(text('careful'))],
        })
      )
    ).toBe('> **WARNING**\n>\n> careful');
  });

  it('renders a header row as a markdown table', () => {
    const header = (value: string) => ({ type: 'tableHeader', content: [paragraph(text(value))] });
    const cell = (value: string) => ({ type: 'tableCell', content: [paragraph(text(value))] });
    const node = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [header('Window'), header('Owner')] },
        { type: 'tableRow', content: [cell('Sat 02:00'), cell('Platform')] },
      ],
    });
    expect(adfToMarkdown(node)).toBe('| Window | Owner |\n| --- | --- |\n| Sat 02:00 | Platform |');
  });

  it('escapes pipes in cells and pads ragged rows', () => {
    const cell = (value: string) => ({ type: 'tableCell', content: [paragraph(text(value))] });
    const node = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('a|b'), cell('two')] },
        { type: 'tableRow', content: [cell('only one')] },
      ],
    });
    // No header row, so the header is left blank rather than stealing a data row.
    expect(adfToMarkdown(node)).toBe('|  |  |\n| --- | --- |\n| a\\|b | two |\n| only one |  |');
  });

  it('renders inline nodes', () => {
    const node = doc(
      paragraph(
        { type: 'mention', attrs: { text: '@Dana Lin' } },
        text(' '),
        { type: 'emoji', attrs: { shortName: ':warning:' } },
        text(' '),
        { type: 'status', attrs: { text: 'APPROVED' } },
        text(' '),
        { type: 'inlineCard', attrs: { url: 'https://x.test/CHG-20' } },
        text(' '),
        { type: 'date', attrs: { timestamp: '1767225600000' } }
      )
    );
    expect(adfToMarkdown(node)).toBe(
      '@Dana Lin :warning: [APPROVED] <https://x.test/CHG-20> 2026-01-01'
    );
  });

  it('falls back to the account id for a mention with no text', () => {
    expect(adfToMarkdown(doc(paragraph({ type: 'mention', attrs: { id: 'abc-123' } })))).toBe(
      '@abc-123'
    );
  });

  it('names attachments without linking to them', () => {
    const node = doc({
      type: 'mediaSingle',
      content: [{ type: 'media', attrs: { alt: 'runbook.pdf', id: 'file-1' } }],
    });
    expect(adfToMarkdown(node)).toBe('[attachment: runbook.pdf]');
  });

  it('titles expands', () => {
    const node = doc({
      type: 'expand',
      attrs: { title: 'Rollback' },
      content: [paragraph(text('restore the snapshot'))],
    });
    expect(adfToMarkdown(node)).toBe('**Rollback**\n\nrestore the snapshot');
  });

  it('renders a rule', () => {
    expect(adfToMarkdown(doc({ type: 'rule' }))).toBe('---');
  });

  it('keeps text under an unrecognised node type', () => {
    const node = doc({ type: 'someFutureNode', content: [paragraph(text('still readable'))] });
    expect(adfToMarkdown(node)).toBe('still readable');
  });

  it('tolerates an inline leaf where a block belongs', () => {
    expect(adfToMarkdown(doc(text('bare text')))).toBe('bare text');
  });

  it('returns empty for an empty or unusable document', () => {
    expect(adfToMarkdown(doc())).toBe('');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown('not a node')).toBe('');
    expect(adfToMarkdown([])).toBe('');
  });
});

describe('isEmptyAdf', () => {
  it('is true for a document that renders to nothing', () => {
    expect(isEmptyAdf(doc())).toBe(true);
    expect(isEmptyAdf(doc(paragraph()))).toBe(true);
    expect(isEmptyAdf(null)).toBe(true);
  });

  it('is false once there is text', () => {
    expect(isEmptyAdf(doc(paragraph(text('something'))))).toBe(false);
  });
});
