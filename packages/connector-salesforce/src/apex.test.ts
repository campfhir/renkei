import {
  APEX_LINE_CHARS,
  apexListPage,
  apexListQuery,
  apexNameSuggestionQuery,
  apexSourceQuery,
  findInSource,
  sourceLines,
  sourceWindow,
  triggerEvents,
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
      cutLine: null,
    });
  });

  it('gives the source exactly as saved, nothing added, without line numbers', () => {
    const body = 'public class A {\n  Integer x;\n}';
    const window = sourceWindow(body, { lineNumbers: false });
    if ('error' in window) throw new Error(window.error);
    expect(window.text).toBe(body);

    const middle = sourceWindow(classOf(5000), { startLine: 10, endLine: 11, lineNumbers: false });
    if ('error' in middle) throw new Error(middle.error);
    expect(middle.text).toBe('// line 10\n// line 11');
  });

  it('pages plain windows the same way, every line read once', () => {
    const body = classOf(3000);
    const read: string[] = [];
    let start: number | null = 1;
    while (start !== null) {
      const window = sourceWindow(body, { startLine: start, maxChars: 4000, lineNumbers: false });
      if ('error' in window) throw new Error(window.error);
      read.push(window.text);
      start = window.nextStart;
    }
    expect(read.join('\n')).toBe(body);
  });

  it('cuts a plain line too long for any window, saying so beside the source, not in it', () => {
    const long = 'x'.repeat(500);
    const window = sourceWindow(`a\n${long}\nb`, {
      startLine: 2,
      maxChars: 100,
      lineNumbers: false,
    });
    if ('error' in window) throw new Error(window.error);
    expect(window.text).toBe('x'.repeat(100));
    expect(window.cutLine).toEqual({ line: 2, length: 500 });
    expect(window.nextStart).toBe(3);
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

describe('listing Apex classes and triggers', () => {
  it("lists the org's own classes by name, without their bodies", () => {
    const q = apexListQuery('class');
    expect(q).toBe(
      'SELECT Id, Name, NamespacePrefix, ApiVersion, Status, LengthWithoutComments, ' +
        'LastModifiedDate, LastModifiedBy.Name FROM ApexClass WHERE NamespacePrefix = null ' +
        'ORDER BY Name, NamespacePrefix NULLS FIRST, Id'
    );
    expect(q).not.toContain('Body');
    expect(q).not.toContain('LIMIT');
  });

  it('includes packages, filters by name and object, and starts after a name', () => {
    const q = apexListQuery('trigger', {
      includePackages: true,
      nameContains: "Acc_' x",
      object: 'Account',
      afterName: 'AccountA',
    });
    expect(q).toContain('TableEnumOrId, UsageBeforeInsert');
    expect(q).not.toContain('NamespacePrefix = null');
    expect(q).toContain("Name LIKE '%Acc\\_\\' x%'");
    expect(q).toContain("TableEnumOrId = 'Account'");
    expect(q).toContain("Name > 'AccountA'");
  });

  it('ignores an object for classes, which fire on none', () => {
    expect(apexListQuery('class', { object: 'Account' })).not.toContain('TableEnumOrId');
  });

  it("names a trigger's events in the order they run", () => {
    expect(
      triggerEvents({ UsageAfterUpdate: true, UsageBeforeInsert: true, UsageAfterDelete: false })
    ).toEqual(['before insert', 'after update']);
  });

  it('shows a page and says the name the next one starts after', () => {
    const rows = ['A', 'B', 'C', 'D'].map((Name) => ({ Name }));
    expect(apexListPage(rows, 2, false)).toEqual({ shown: rows.slice(0, 2), afterName: 'B' });
    expect(apexListPage(rows, 10, false)).toEqual({ shown: rows, afterName: null });
    expect(apexListPage(rows, 10, true)).toEqual({ shown: rows, afterName: 'D' });
  });

  it('never ends a page part-way through one name, which the next page would skip', () => {
    const rows = [{ Name: 'A' }, { Name: 'Same' }, { Name: 'same' }, { Name: 'Z' }];
    expect(apexListPage(rows, 2, false)).toEqual({ shown: rows.slice(0, 3), afterName: 'same' });
  });
});
