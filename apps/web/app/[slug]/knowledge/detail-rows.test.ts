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
