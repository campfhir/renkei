/**
 * The details panel.
 *
 * It replaced a JSON dump, so the tests are mostly about what must NOT appear:
 * no braces, no repeat of the title already on the card, no `[object Object]`.
 */

import { detailRows } from './detail-rows';

const hit = (metadata: Record<string, unknown>) => ({
  provider: 'jira',
  refId: 'OPS-1042',
  distance: 0,
  metadata,
});

describe('detailRows', () => {
  it('always identifies the source and reference', () => {
    const rows = detailRows(hit({}));
    expect(rows).toContainEqual({ label: 'Source', value: 'jira' });
    expect(rows).toContainEqual({ label: 'Reference', value: 'OPS-1042' });
  });

  it('does not repeat what the card already shows', () => {
    // The title sits at the top of the same card; printing it again was the
    // most visible thing wrong with the JSON dump.
    const rows = detailRows(
      hit({ title: 'OPS-1042: Nightly export review', kind: 'issue', project: 'OPS' })
    );
    expect(rows.map((row) => row.label)).not.toContain('Title');
    expect(rows.map((row) => row.label)).not.toContain('Kind');
    expect(rows).toContainEqual({ label: 'Project', value: 'OPS' });
  });

  it('gives keys words instead of identifiers', () => {
    const rows = detailRows(hit({ spaceId: 'ENG', driveId: 'b!x' }));
    const labels = rows.map((row) => row.label);
    expect(labels).toContain('Space');
    expect(labels).toContain('Drive');
    expect(labels.join(' ')).not.toContain('spaceId');
  });

  it('humanizes a key nobody has labelled yet', () => {
    const rows = detailRows(hit({ lastEditedBy: 'Alex Mercer' }));
    expect(rows).toContainEqual({ label: 'Last edited by', value: 'Alex Mercer' });
  });

  it('joins a list rather than printing an array', () => {
    const rows = detailRows(hit({ labels: ['billing', 'sso'] }));
    expect(rows).toContainEqual({ label: 'Labels', value: 'billing, sso' });
  });

  it('drops values that would render as noise', () => {
    const rows = detailRows(hit({ nested: { a: 1 }, blank: '   ', missing: null }));
    const labels = rows.map((row) => row.label);
    expect(labels).not.toContain('Nested');
    expect(labels).not.toContain('Blank');
    expect(labels).not.toContain('Missing');
    expect(rows.map((row) => row.value).join(' ')).not.toContain('[object Object]');
  });

  it('names the distance rather than showing a bare number', () => {
    const rows = detailRows({ ...hit({}), distance: 0.1234 });
    expect(rows[rows.length - 1]).toEqual({ label: 'Match distance', value: '0.123' });
  });
});

describe('resolved connector metadata', () => {
  it('shows a Jira issue by its words, not its ids', () => {
    const rows = detailRows({
      provider: 'jira',
      refId: 'ENG-787',
      distance: 0.1,
      metadata: {
        kind: 'issue',
        title: 'ENG-787: Permissions',
        ticket: 'ENG-787',
        project: 'Engineering',
        projectKey: 'ENG',
        reporter: 'Evan Jeing',
        reporterId: '623e4e98a1d81f0069da1532',
        assignee: 'Scott Eremia-Roden',
        requestType: 'Application Error',
        url: 'https://acme.atlassian.net/browse/ENG-787',
      },
    });
    const labels = rows.map((row) => row.label);
    expect(labels).toEqual(expect.arrayContaining(['Ticket', 'Reporter', 'Request type']));
    expect(rows.find((row) => row.label === 'Reporter')?.value).toBe('Evan Jeing');
    // The accountId is kept in the record for matching, but a person
    // reading the card is not shown it under the name.
    expect(labels).not.toContain('Reporter id');
    // The link is a link, not a row of raw href text.
    expect(labels).not.toContain('Url');
  });

  it('shows a mail item by who it involved', () => {
    const rows = detailRows({
      provider: 'microsoft',
      refId: 'user@x/msg/1',
      distance: 0.2,
      metadata: {
        kind: 'msg',
        subject: 'Printers',
        from: 'Evan Jeing <evan.jeing@nems.org>',
        fromAddress: 'evan.jeing@nems.org',
        to: ['Scott Eremia-Roden <scott@nems.org>'],
        toAddresses: ['scott@nems.org'],
        cc: ['Help Desk <help@nems.org>'],
      },
    });
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    expect(byLabel.get('From')).toBe('Evan Jeing <evan.jeing@nems.org>');
    expect(byLabel.get('To')).toBe('Scott Eremia-Roden <scott@nems.org>');
    expect(byLabel.get('Cc')).toBe('Help Desk <help@nems.org>');
    // Address-only twins stay out of the reading view.
    expect(byLabel.has('From address')).toBe(false);
  });

  it('shows a SharePoint file by name, site and path', () => {
    const rows = detailRows({
      provider: 'sharepoint',
      refId: 'drive-1/item-1',
      distance: 0.3,
      metadata: {
        kind: 'doc',
        fileName: 'Runbook.docx',
        site: 'Information Services / Documents',
        path: '/Shared Documents/Runbook.docx',
        lastModifiedBy: 'Evan Jeing',
        cTag: 'c-tag-value',
      },
    });
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    expect(byLabel.get('File')).toBe('Runbook.docx');
    expect(byLabel.get('Site')).toBe('Information Services / Documents');
    expect(byLabel.get('Last edited by')).toBe('Evan Jeing');
    // Sync plumbing is not content.
    expect(byLabel.has('C tag')).toBe(false);
  });
});
