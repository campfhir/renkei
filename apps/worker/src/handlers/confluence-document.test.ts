/**
 * Flattening a Confluence page.
 *
 * The behaviour this replaces joined every text node with a space, so a page
 * arrived as one unbroken line with no headings, paragraphs or bullets — bad
 * to read and worse to chunk, since the splitter had no boundary to cut on.
 */

import { confluenceDocument } from './confluence-document';

const page = (...content: unknown[]) => JSON.stringify({ type: 'doc', version: 1, content });
const heading = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const bullets = (...items: string[]) => ({
  type: 'bulletList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })),
});

describe('confluenceDocument', () => {
  it('keeps the structure the old text walk destroyed', () => {
    const document = confluenceDocument(
      'Runbook',
      page(heading(1, 'Restarting'), para('Restart the worker first.'), bullets('Revert the image'))
    );
    expect(document).toContain('# Runbook');
    expect(document).toContain('Restart the worker first.');
    expect(document).toContain('- Revert the image');
    // The old output was a single line; this one has real paragraph breaks
    // for the chunker to cut on.
    expect(document.split('\n\n').length).toBeGreaterThan(2);
  });

  it('nests the page’s own headings under the page title', () => {
    const document = confluenceDocument(
      'Runbook',
      page(heading(1, 'Restarting'), heading(2, 'Rollback'))
    );
    expect(document).toContain('# Runbook');
    expect(document).toContain('## Restarting');
    expect(document).toContain('### Rollback');
    // Nothing else may sit level with the title.
    expect(document.split('\n').filter((line) => /^# /.test(line))).toHaveLength(1);
  });

  it('does not demote when there is no title to nest under', () => {
    const document = confluenceDocument('', page(heading(1, 'Restarting')));
    expect(document).toBe('# Restarting');
  });

  it('keeps the title when the body will not parse', () => {
    // A broken body is not a reason to lose the page.
    expect(confluenceDocument('Runbook', 'not json')).toBe('# Runbook');
  });

  it('handles an empty body', () => {
    expect(confluenceDocument('Runbook', '')).toBe('# Runbook');
  });

  it('returns nothing when there is nothing', () => {
    expect(confluenceDocument('', '')).toBe('');
  });
});
