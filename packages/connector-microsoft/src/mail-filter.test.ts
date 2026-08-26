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
    const filter = filterOf(buildMailQueryPath({ categories: ['red', 'blue'] }, { top: 10 }));
    expect(filter).toContain("categories/any(c:c eq 'red')");
    expect(filter).toContain("categories/any(c:c eq 'blue')");
  });

  it('honors a custom $select', () => {
    expect(buildMailQueryPath({}, { top: 10, select: 'id,subject' })).toContain(
      '$select=id,subject'
    );
  });
});

/**
 * The half of Exchange's rule that used to be missing.
 *
 * Clause ORDER was handled; clause PRESENCE was not, so a search that named
 * no date range produced `$orderby=receivedDateTime desc` over a $filter
 * that never mentioned receivedDateTime. Reproduced live on 2026-08-26:
 * `{from}`, `{from, hasAttachments}` and `{flagStatus}` each answered a bare
 * 400 while `{isRead}` alone succeeded, which is why these assert on the
 * built path rather than on any live behaviour — the failure is Exchange's
 * to report and nothing here can provoke it.
 */
describe('buildMailQueryPath keeps $orderby inside $filter', () => {
  const leads = (path: string) => filterOf(path).indexOf('receivedDateTime ge') === 0;

  it.each([
    ['from alone', { from: 'a@example.com' }],
    ['from with attachments', { from: 'a@example.com', hasAttachments: true }],
    ['flagStatus alone', { flagStatus: 'flagged' }],
    ['categories alone', { categories: ['red'] }],
    ['isRead alone', { isRead: false }],
  ])('leads with a receivedDateTime clause for %s', (_name, filters) => {
    expect(leads(buildMailQueryPath(filters, { top: 25 }))).toBe(true);
  });

  it('excludes nothing with the bound it invents', () => {
    // The clause exists to name the property, not to narrow the search, so
    // it has to sit below any mail a mailbox could hold.
    const filter = filterOf(buildMailQueryPath({ from: 'a@example.com' }, { top: 25 }));
    const bound = /receivedDateTime ge (\S+)/.exec(filter)?.[1] ?? '';
    expect(new Date(bound).getUTCFullYear()).toBeLessThanOrEqual(1970);
  });

  it('does not invent a bound when the caller gave one', () => {
    // Two lower bounds would be redundant at best; if the invented one ever
    // came second it would also break the ordering rule it exists to serve.
    const filter = filterOf(
      buildMailQueryPath(
        { from: 'a@example.com', receivedAfter: '2026-01-01T00:00:00Z' },
        { top: 25 }
      )
    );
    expect(filter.match(/receivedDateTime ge/g)).toHaveLength(1);
    expect(filter).toContain('receivedDateTime ge 2026-01-01T00:00:00Z');
  });

  it('still sends no $filter at all when nothing was asked for', () => {
    // A bare $orderby has no combination to be rejected, so an unfiltered
    // search must not acquire a filter it never needed.
    expect(buildMailQueryPath({}, { top: 25 })).not.toContain('$filter');
    expect(buildMailQueryPath({ subjectContains: 'invoice' }, { top: 25 })).not.toContain(
      '$filter'
    );
  });
});
