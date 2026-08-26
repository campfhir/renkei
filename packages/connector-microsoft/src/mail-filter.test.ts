/**
 * The mail query builder's load-bearing rules: date clauses lead the
 * $filter (Exchange answers 400 InefficientFilter when $orderby properties
 * trail others), quotes are escaped, and subjectContains never compiles
 * into $filter (Graph has no working contains() for mail subjects — callers
 * match client-side).
 */

import {
  buildMailQueryPath,
  clientSideSelect,
  hasClientSideFilter,
  matchesClientSide,
} from './mail-filter';

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

/**
 * The filters Exchange cannot apply.
 *
 * `to` and `cc` are here rather than in $filter because Exchange supports
 * no filtering on the recipient COLLECTIONS at all — not equality, not a
 * `toRecipients/any(...)` lambda. $search can ask the question, but $search
 * and $filter are mutually exclusive on mail, so using it would cost every
 * other filter in the type.
 *
 * One implementation, shared by the interactive search and the worker's
 * bulk-job expansion. The stakes differ between them: a search that ignores
 * a filter returns a thin page, while an EXPANSION that ignores one selects
 * the wrong messages and the job then deletes or moves them.
 */
describe('matchesClientSide', () => {
  const message = {
    subject: 'Q3 invoice',
    toRecipients: [
      { emailAddress: { name: 'Dana', address: 'Dana@Example.com' } },
      { emailAddress: { name: 'Ops', address: 'ops@example.com' } },
    ],
    ccRecipients: [{ emailAddress: { name: 'Finance', address: 'finance@example.com' } }],
  };

  it('passes a message when nothing has to be matched here', () => {
    expect(matchesClientSide(message, {})).toBe(true);
    expect(matchesClientSide(message, { from: 'x@example.com', isRead: false })).toBe(true);
  });

  it('matches a To address regardless of case, on either side', () => {
    expect(matchesClientSide(message, { to: 'dana@example.com' })).toBe(true);
    expect(matchesClientSide(message, { to: 'OPS@EXAMPLE.COM' })).toBe(true);
  });

  it('matches any recipient on the line, not only the first', () => {
    expect(matchesClientSide(message, { to: 'ops@example.com' })).toBe(true);
  });

  it('keeps To and Cc apart', () => {
    // Asking for a Cc recipient on the To line has to fail, or "who was
    // copied" and "who was addressed" stop being different questions.
    expect(matchesClientSide(message, { to: 'finance@example.com' })).toBe(false);
    expect(matchesClientSide(message, { cc: 'finance@example.com' })).toBe(true);
    expect(matchesClientSide(message, { cc: 'dana@example.com' })).toBe(false);
  });

  it('does not match a display name', () => {
    // Documented as an address match. Matching names too would make
    // "Dana" match every Dana in the company.
    expect(matchesClientSide(message, { to: 'Dana' })).toBe(false);
  });

  it('tolerates padding around the address', () => {
    expect(matchesClientSide(message, { to: '  dana@example.com  ' })).toBe(true);
  });

  it('ANDs the client-side filters together', () => {
    expect(matchesClientSide(message, { to: 'dana@example.com', subjectContains: 'invoice' })).toBe(
      true
    );
    expect(matchesClientSide(message, { to: 'dana@example.com', subjectContains: 'receipt' })).toBe(
      false
    );
  });

  it('fails closed when the message carries no recipients at all', () => {
    // A missing collection is not "matches anything" — that would hand a
    // bulk job every message whose $select forgot the field.
    expect(matchesClientSide({ subject: 'x' }, { to: 'dana@example.com' })).toBe(false);
    expect(matchesClientSide({ toRecipients: 'nonsense' }, { to: 'dana@example.com' })).toBe(false);
    expect(matchesClientSide({ toRecipients: [{}, null] }, { to: 'dana@example.com' })).toBe(false);
  });
});

describe('clientSideSelect', () => {
  it('adds only the fields the match will actually read', () => {
    expect(clientSideSelect({ to: 'a@b.com' }, 'id')).toBe('id,toRecipients');
    expect(clientSideSelect({ cc: 'a@b.com' }, 'id')).toBe('id,ccRecipients');
    expect(clientSideSelect({ subjectContains: 'x' }, 'id')).toBe('id,subject');
  });

  it('leaves the projection alone when nothing is matched here', () => {
    // Recipient collections are the heaviest part of a message summary; a
    // 1000-message survey must not carry them for nothing.
    expect(clientSideSelect({ from: 'a@b.com' }, 'id,subject')).toBe('id,subject');
  });

  it('does not duplicate a field the caller already asked for', () => {
    expect(clientSideSelect({ subjectContains: 'x' }, 'id,subject')).toBe('id,subject');
  });
});

describe('hasClientSideFilter', () => {
  it('is true for exactly the filters Exchange cannot apply', () => {
    expect(hasClientSideFilter({ to: 'a@b.com' })).toBe(true);
    expect(hasClientSideFilter({ cc: 'a@b.com' })).toBe(true);
    expect(hasClientSideFilter({ subjectContains: 'x' })).toBe(true);
    expect(hasClientSideFilter({ from: 'a@b.com', isRead: true, flagStatus: 'flagged' })).toBe(
      false
    );
    expect(hasClientSideFilter({})).toBe(false);
  });
});
