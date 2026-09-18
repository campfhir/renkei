import {
  normalizeQuery,
  searchableText,
  snippetAround,
  CHAT_SEARCH_MAX_CHARS,
} from './search-text';

describe('searchableText', () => {
  it('keeps text blocks only, in order', () => {
    expect(
      searchableText([
        { type: 'thinking', thinking: 'secret plan' },
        { type: 'text', text: 'first' },
        { type: 'tool_use', id: 't1', name: 'jira_search_issues', input: { jql: 'x' } },
        { type: 'tool_result', toolUseId: 't1', content: '{"issues":[]}' },
        { type: 'text', text: 'second' },
      ])
    ).toBe('first\nsecond');
  });

  it('is empty for a message with no prose', () => {
    expect(searchableText([{ type: 'image', mediaType: 'image/png', dataBase64: '' }])).toBe('');
  });
});

describe('normalizeQuery', () => {
  it('trims, folds case and collapses whitespace', () => {
    expect(normalizeQuery('  Zoom   Webhook\n secret ')).toBe('zoom webhook secret');
  });

  it('caps the length', () => {
    expect(normalizeQuery('x'.repeat(CHAT_SEARCH_MAX_CHARS + 50))).toHaveLength(
      CHAT_SEARCH_MAX_CHARS
    );
  });
});

describe('snippetAround', () => {
  it('is null when the text does not contain the query', () => {
    expect(snippetAround('Rotate the Zoom webhook secret', 'fileshare')).toBeNull();
    expect(snippetAround('anything', '   ')).toBeNull();
  });

  it('returns the whole line, uncut, when it is short', () => {
    expect(snippetAround('Rotate the Zoom webhook secret', 'WEBHOOK')).toBe(
      'Rotate the Zoom webhook secret'
    );
  });

  it('flattens newlines and matches across them', () => {
    expect(snippetAround('Two issues slipped:\n\n| OPS-41 | Rotate |', 'ops-41')).toBe(
      'Two issues slipped: | OPS-41 | Rotate |'
    );
  });

  it('windows a long text around the match and marks the cuts at word edges', () => {
    const before = Array.from({ length: 30 }, (_, i) => `before${i}`).join(' ');
    const after = Array.from({ length: 30 }, (_, i) => `after${i}`).join(' ');
    const snippet = snippetAround(`${before} needle ${after}`, 'needle');
    expect(snippet).not.toBeNull();
    expect(snippet).toMatch(/^…before\d+ .*needle.* after\d+…$/);
    expect(snippet).toContain(' needle ');
    expect(snippet?.length).toBeLessThan(160);
  });

  it('drops the partial words a cut leaves on either side', () => {
    const text = `${'x'.repeat(100)} the needle sits here ${'y'.repeat(100)}`;
    expect(snippetAround(text, 'the needle sits here')).toBe('…the needle sits here…');
  });
});
