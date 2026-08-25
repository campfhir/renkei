import { MAX_LOGGED_TITLES, TitleList, summariseTitles } from './log-titles';

describe('TitleList', () => {
  it('lists what it took in', () => {
    const list = new TitleList();
    list.add('Quarterly plan.docx');
    list.add('Runbook.pdf');
    expect(list.titles()).toEqual(['Quarterly plan.docx', 'Runbook.pdf']);
    expect(list.summary()).toBe('Quarterly plan.docx, Runbook.pdf');
  });

  it('counts the ones it did not keep', () => {
    // The count must stay truthful once the kept list is full — otherwise a
    // sweep of forty documents reads as a sweep of five.
    const list = new TitleList();
    for (let index = 0; index < MAX_LOGGED_TITLES + 3; index += 1) list.add(`doc-${index}`);
    expect(list.titles()).toHaveLength(MAX_LOGGED_TITLES);
    expect(list.summary()).toContain('and 3 more');
  });

  it('ignores documents with no usable name', () => {
    const list = new TitleList();
    list.add('');
    list.add('   ');
    list.add(null);
    list.add(undefined);
    expect(list.titles()).toEqual([]);
    // Never an empty string: an empty attribute would render as a gap in the
    // sentence, and a missing one would leave a literal {documents} behind.
    expect(list.summary()).toBe('no titles recorded');
  });

  it('truncates a pathological filename rather than letting it dominate', () => {
    const list = new TitleList();
    list.add('x'.repeat(500));
    const [only] = list.titles();
    expect(only.length).toBeLessThanOrEqual(120);
    expect(only.endsWith('…')).toBe(true);
  });

  it('collapses whitespace so a line stays one line', () => {
    const list = new TitleList();
    list.add('  Meeting\n  notes  ');
    expect(list.titles()).toEqual(['Meeting notes']);
  });

  it('summarises a pre-bounded list against a larger total', () => {
    // The sweep only has the kept titles and the total count, never the
    // collector itself.
    expect(summariseTitles(['a', 'b'], 7)).toBe('a, b and 5 more');
    expect(summariseTitles(['a', 'b'], 2)).toBe('a, b');
    expect(summariseTitles([], 0)).toBe('no titles recorded');
  });

  it('never claims a negative remainder', () => {
    expect(summariseTitles(['a', 'b'], 1)).toBe('a, b');
  });
});
