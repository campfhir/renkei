import {
  APEX_LINE_CHARS,
  apexNameSuggestionQuery,
  apexSourceQuery,
  findInSource,
  sourceLines,
  sourceWindow,
} from './apex';

/** A class of `n` numbered lines: `// line 1`, `// line 2`, … */
const classOf = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join('\n');

describe('reading Apex source a window at a time', () => {
  it('numbers lines and reads the whole of a small class in one window', () => {
    const window = sourceWindow('public class A {\n  Integer x;\n}\n');
    expect(window).toEqual({
      text: '1  public class A {\n2    Integer x;\n3  }',
      firstLine: 1,
      lastLine: 3,
      totalLines: 3,
      nextStart: null,
      stoppedAtLimit: false,
    });
  });

  it('reads the middle of a large class without the start', () => {
    const window = sourceWindow(classOf(5000), { startLine: 2400, endLine: 2402 });
    if ('error' in window) throw new Error(window.error);
    expect(window.text).toBe('2400  // line 2400\n2401  // line 2401\n2402  // line 2402');
    expect(window.totalLines).toBe(5000);
    expect(window.nextStart).toBeNull();
  });

  it('stops at the size bound and says where the next window starts, until the end is reached', () => {
    const body = classOf(5000);
    const seen: number[] = [];
    let start: number | null = 1;
    while (start !== null) {
      const window = sourceWindow(body, { startLine: start, maxChars: 4000 });
      if ('error' in window) throw new Error(window.error);
      expect(window.text.length).toBeLessThanOrEqual(4000);
      seen.push(window.firstLine, window.lastLine);
      start = window.nextStart;
    }
    // Every line read once, in order, and the last window ends on the last line.
    expect(seen[0]).toBe(1);
    expect(seen[seen.length - 1]).toBe(5000);
    for (let i = 2; i < seen.length; i += 2) expect(seen[i]).toBe(seen[i - 1] + 1);
  });

  it('always moves forward, cutting a single line longer than the window', () => {
    const body = `short\n${'x'.repeat(APEX_LINE_CHARS + 500)}\nafter`;
    const window = sourceWindow(body, { startLine: 2, maxChars: 100 });
    if ('error' in window) throw new Error(window.error);
    expect(window.lastLine).toBe(2);
    expect(window.nextStart).toBe(3);
    expect(window.text).toContain('[line cut: 500 more characters]');
  });

  it('says a start past the end, or an end before the start, rather than reading nothing', () => {
    expect(sourceWindow(classOf(10), { startLine: 11 })).toEqual({
      error: 'It has 10 lines; line 11 is past the end.',
    });
    expect(sourceWindow(classOf(10), { startLine: 5, endLine: 4 })).toEqual({
      error: 'endLine 4 is before startLine 5.',
    });
  });

  it('reads any line ending, and does not count a trailing newline as a line', () => {
    expect(sourceLines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c']);
  });
});

describe('finding where something is in the source', () => {
  it('names the matching lines, ignoring case as Apex does', () => {
    const body = 'public class A {\n  void Process() {}\n  void run() { process(); }\n}';
    expect(findInSource(body, 'PROCESS')).toEqual({
      hits: [
        { line: 2, text: 'void Process() {}' },
        { line: 3, text: 'void run() { process(); }' },
      ],
      total: 2,
    });
  });

  it('stops naming lines at the bound but counts them all', () => {
    const found = findInSource(classOf(500), 'line', 10);
    expect(found.hits).toHaveLength(10);
    expect(found.total).toBe(500);
  });
});

describe('the queries', () => {
  it('reads a class by its exact name, escaped, the org’s own before a package’s', () => {
    expect(apexSourceQuery('class', "O'Brien")).toBe(
      'SELECT Id, Name, NamespacePrefix, ApiVersion, Status, Body, LengthWithoutComments, ' +
        "LastModifiedDate, LastModifiedBy.Name FROM ApexClass WHERE Name = 'O\\'Brien' " +
        'ORDER BY NamespacePrefix NULLS FIRST LIMIT 5'
    );
    expect(apexSourceQuery('trigger', 'AccountTrigger')).toContain(
      ', TableEnumOrId FROM ApexTrigger'
    );
  });

  it('suggests names containing the words, an underscore matching only itself', () => {
    expect(apexNameSuggestionQuery('class', 'Account_Svc')).toBe(
      "SELECT Name, NamespacePrefix FROM ApexClass WHERE Name LIKE '%Account\\_Svc%' ORDER BY Name LIMIT 10"
    );
  });
});
