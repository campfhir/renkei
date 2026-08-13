/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * GFM tables were previously "unsupported by choice", which in practice
 * meant a model's comparison table arrived in Jira and Confluence as a wall
 * of pipe characters. adf.ts could already READ tables, so the gap was only
 * ever in the writer.
 *
 * The delicate part is not the table itself but everything adjacent to it:
 * prose containing a pipe must stay prose, and a ragged row must not cost
 * the document.
 */

import { markdownToAdf } from './markdown';

interface Node {
  type: string;
  text?: string;
  content?: Node[];
  attrs?: Record<string, unknown>;
}

function firstOfType(nodes: Node[], type: string): Node | undefined {
  for (const node of nodes) {
    if (node.type === type) return node;
    const found = node.content ? firstOfType(node.content, type) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** The plain text of a cell, however deeply the paragraph nests it. */
function textOf(node: Node | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

const TABLE = [
  '| Rule | Hit count behavior |',
  '|---|---|',
  '| NAT rule | Climbing steadily |',
  '| Security rule | Effectively zero |',
].join('\n');

describe('markdownToAdf — tables', () => {
  it('builds a real ADF table, with the first row as headers', () => {
    const doc = markdownToAdf(TABLE);
    const table = firstOfType(doc.content as Node[], 'table');
    expect(table).toBeDefined();

    const rows = table?.content ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.content?.[0]?.type).toBe('tableHeader');
    expect(rows[1]?.content?.[0]?.type).toBe('tableCell');
    expect(textOf(rows[0]?.content?.[0])).toBe('Rule');
    expect(textOf(rows[2]?.content?.[1])).toBe('Effectively zero');
  });

  it('accepts alignment colons in the delimiter row', () => {
    const doc = markdownToAdf(['| A | B |', '|:--|--:|', '| 1 | 2 |'].join('\n'));
    expect(firstOfType(doc.content as Node[], 'table')).toBeDefined();
  });

  it('pads a short row instead of dropping the document', () => {
    const doc = markdownToAdf(['| A | B |', '|---|---|', '| only-one |'].join('\n'));
    const rows = firstOfType(doc.content as Node[], 'table')?.content ?? [];
    expect(rows[1]?.content).toHaveLength(2);
    expect(textOf(rows[1]?.content?.[1])).toBe('');
  });

  it('leaves prose containing a pipe as prose', () => {
    // The delimiter row is what makes a table; without it a pipe is a pipe.
    const doc = markdownToAdf('A plausible theory was a port typo (5001 | 50001).');
    expect(firstOfType(doc.content as Node[], 'table')).toBeUndefined();
    expect(textOf(doc.content[0] as Node)).toContain('5001 | 50001');
  });

  it('keeps an escaped pipe inside a cell', () => {
    const doc = markdownToAdf(['| A | B |', '|---|---|', '| x \\| y | z |'].join('\n'));
    const rows = firstOfType(doc.content as Node[], 'table')?.content ?? [];
    expect(textOf(rows[1]?.content?.[0])).toBe('x | y');
  });

  it('starts a table that directly follows a paragraph', () => {
    const doc = markdownToAdf(['Some prose.', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'));
    expect(doc.content[0]?.type).toBe('paragraph');
    expect(firstOfType(doc.content as Node[], 'table')).toBeDefined();
  });
});
