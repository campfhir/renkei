/**
 * The contextual header: derived from whichever title key a connector
 * set, prepended to the embedding input of multi-chunk pieces only, and
 * never to a single-chunk object (whose stored content already opens
 * with its own head, and whose precomputed vector depends on that).
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn() }));

import { chunkContext, titleOf, embeddingInput } from './context';
import { embeddingInputs } from './chunking';

describe('chunkContext', () => {
  it('reads the most specific title key a connector set', () => {
    expect(chunkContext({ subject: 'Vendor contract renewal' })).toBe(
      'Subject: Vendor contract renewal'
    );
    expect(chunkContext({ topic: 'Weekly sync' })).toBe('Meeting: Weekly sync');
    expect(chunkContext({ title: 'Runbook' })).toBe('Title: Runbook');
    expect(chunkContext({ name: 'Q3 roadmap.docx', fileName: 'Q3 roadmap.docx' })).toBe(
      'Document: Q3 roadmap.docx'
    );
  });

  it('is empty when nothing names the document', () => {
    expect(chunkContext({})).toBe('');
    expect(chunkContext({ subject: '   ' })).toBe('');
    expect(chunkContext({ subject: 42 })).toBe('');
  });

  it('collapses whitespace and bounds the header', () => {
    expect(titleOf({ subject: 'a  \n b' })).toBe('a b');
    expect(titleOf({ subject: 'x'.repeat(500) }).length).toBeLessThanOrEqual(200);
  });
});

describe('embeddingInputs', () => {
  it('leaves a single chunk bare, whatever the context', () => {
    expect(embeddingInputs(['only piece'], 'Subject: Hi')).toEqual(['only piece']);
  });

  it('prepends the header to every piece of a multi-chunk object', () => {
    expect(embeddingInputs(['one', 'two'], 'Title: Page')).toEqual([
      'Title: Page\n\none',
      'Title: Page\n\ntwo',
    ]);
  });

  it('prepends nothing when there is no header', () => {
    expect(embeddingInputs(['one', 'two'], '')).toEqual(['one', 'two']);
  });

  it('separates header and chunk with a blank line', () => {
    expect(embeddingInput('Subject: Hi', 'body')).toBe('Subject: Hi\n\nbody');
    expect(embeddingInput('', 'body')).toBe('body');
  });
});
