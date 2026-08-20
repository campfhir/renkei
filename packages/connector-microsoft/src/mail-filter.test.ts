/**
 * The mail query builder's load-bearing rules: date clauses lead the
 * $filter (Exchange answers 400 InefficientFilter when $orderby properties
 * trail others), quotes are escaped, and subjectContains never compiles
 * into $filter (Graph has no working contains() for mail subjects — callers
 * match client-side).
 */

import { buildMailQueryPath } from './mail-filter';

function filterOf(path: string): string {
  const match = /\$filter=([^&]+)/.exec(path);
  return match ? decodeURIComponent(match[1]) : '';
}

describe('buildMailQueryPath', () => {
  it('puts receivedDateTime clauses before every other filter', () => {
    const path = buildMailQueryPath(
      { isRead: false, receivedAfter: '2026-01-01T00:00:00Z', from: 'a@example.com' },
      { top: 50 }
    );
    const filter = filterOf(path);
    expect(filter.indexOf('receivedDateTime ge')).toBe(0);
    expect(filter.indexOf('receivedDateTime ge')).toBeLessThan(filter.indexOf('isRead eq'));
    expect(filter).toContain("from/emailAddress/address eq 'a@example.com'");
  });

  it('scopes to a folder when given and the mailbox otherwise', () => {
    expect(buildMailQueryPath({ folder: 'inbox' }, { top: 10 })).toContain(
      '/me/mailFolders/inbox/messages?'
    );
    expect(buildMailQueryPath({}, { top: 10 })).toContain('/me/messages?');
  });

  it('escapes single quotes in values', () => {
    const path = buildMailQueryPath({ from: "o'brien@example.com" }, { top: 10 });
    expect(filterOf(path)).toContain("o''brien@example.com");
  });

  it('never compiles subjectContains into $filter', () => {
    const path = buildMailQueryPath({ subjectContains: 'invoice', isRead: true }, { top: 10 });
    expect(filterOf(path)).not.toContain('invoice');
    expect(filterOf(path)).toContain('isRead eq true');
  });

  it('omits $filter entirely with no clauses, and adds $count on request', () => {
    const bare = buildMailQueryPath({}, { top: 25 });
    expect(bare).not.toContain('$filter');
    expect(bare).toContain('$top=25');
    expect(bare).toContain('$orderby=receivedDateTime desc');

    expect(buildMailQueryPath({}, { top: 25, withCount: true })).toContain('$count=true');
  });

  it('requires every category in an ALL-of match', () => {
    const filter = filterOf(
      buildMailQueryPath({ categories: ['red', 'blue'] }, { top: 10 })
    );
    expect(filter).toContain("categories/any(c:c eq 'red')");
    expect(filter).toContain("categories/any(c:c eq 'blue')");
  });

  it('honors a custom $select', () => {
    expect(buildMailQueryPath({}, { top: 10, select: 'id,subject' })).toContain(
      '$select=id,subject'
    );
  });
});
