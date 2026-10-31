/**
 * Every admin connector's change requests as one list, on the memory store:
 * an operator's rows are everyone's from both connectors, newest first,
 * each pointing at its own review page; anyone else's are their own; the
 * filter narrows to one connector; and the menu's count adds up what
 * waits, leaving out what was decided.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import * as salesforce from '@/lib/salesforce-admin/change-requests';
import * as jira from '@/lib/jira-admin/change-requests';
import { countChangesAwaitingReview, isChangeSource, listChangeRows } from './sources';

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
});

afterAll(() => {
  resetDataStore();
});

const salesforceProposal = (subject: string, title: string) =>
  salesforce.createChangeRequest({
    subject,
    connectorKey: 'uat',
    orgId: '00D000000000062EAA',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    kind: 'fields',
    title,
    reason: undefined,
    payload: { files: { 'package.xml': '<Package/>' } },
  });

const jiraRequest = (subject: string, title: string) =>
  jira.createRequest({
    subject,
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    title,
    description: 'Source needs Vendor',
  });

describe('change rows', () => {
  it('give an operator everyone’s from every connector, newest first, and anyone else their own', async () => {
    const first = await salesforceProposal('ann', 'Site Visit: add Outcome');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await jiraRequest('bob', 'Add a Vendor option');

    const all = await listChangeRows({ subject: 'olive', operator: true });
    expect(all.map((row) => [row.source, row.id])).toEqual([
      ['jira-admin', second.id],
      ['salesforce-admin', first.id],
    ]);
    expect(all[0]).toMatchObject({
      sourceLabel: 'Jira',
      href: `/jira-admin/changes/${second.id}`,
      where: 'acme.atlassian.net',
      kind: 'request',
      state: 'pending',
      subject: 'bob',
      validation: null,
    });
    expect(all[1]).toMatchObject({
      sourceLabel: 'Salesforce',
      href: `/salesforce-admin/changes/${first.id}`,
      // No org registered here: the connector key stands in for its name.
      where: 'uat',
      kind: 'proposal',
      state: 'pending',
    });

    const anns = await listChangeRows({ subject: 'ann', operator: false });
    expect(anns.map((row) => row.id)).toEqual([first.id]);

    const jiraOnly = await listChangeRows({
      subject: 'olive',
      operator: true,
      source: 'jira-admin',
    });
    expect(jiraOnly.map((row) => row.id)).toEqual([second.id]);
  });

  it('count what waits across connectors, not what was decided', async () => {
    expect(await countChangesAwaitingReview()).toBe(0);
    const declined = await salesforceProposal('ann', 'Site Visit: add Outcome');
    await salesforceProposal('ann', 'Site Visit: add Notes');
    await jiraRequest('bob', 'Add a Vendor option');
    expect(await countChangesAwaitingReview()).toBe(3);

    expect(await salesforce.cancelChangeRequest('olive', declined.id, { operator: true })).toBe(
      true
    );
    expect(await countChangesAwaitingReview()).toBe(2);
    const rows = await listChangeRows({ subject: 'olive', operator: true });
    expect(rows.find((row) => row.id === declined.id)?.state).toBe('cancelled');
  });

  it('know the connectors that queue changes', () => {
    expect(isChangeSource('salesforce-admin')).toBe(true);
    expect(isChangeSource('jira-admin')).toBe(true);
    expect(isChangeSource('github')).toBe(false);
    expect(isChangeSource(undefined)).toBe(false);
  });
});
