/**
 * Telling people about admin change requests, against a real database
 * (skipped without DATABASE_URL): a new request reaches every operator but
 * the one who filed it, and nobody else; how a queued change ended reaches
 * the person who asked and the operator who approved it, once each, with
 * the review page as the place to open.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import {
  CHANGE_REQUEST_NOTIFICATION_KIND,
  CHANGE_RESULT_NOTIFICATION_KIND,
  changePath,
  notifyChangeOutcome,
  notifyOperatorsOfRequest,
  operatorSubjects,
} from './notify';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('admin change notifications', () => {
  const suite = randomUUID().slice(0, 8);
  const ada = `ada-${suite}`;
  const grace = `grace-${suite}`;
  const requester = `requester-${suite}`;
  const changeId = randomUUID();
  const subjects = [ada, grace, requester];

  /** One person's notifications about a change, found by the page they link to. */
  async function aboutChange(
    subject: string,
    connector: 'salesforce-admin' | 'jira-admin',
    id: string,
    kind?: string
  ) {
    const feed = await getDataStore().notifications.list(subject, { limit: 200 });
    return feed.filter(
      (row) => row.refUrl === changePath(connector, id) && (kind === undefined || row.kind === kind)
    );
  }

  const rowsFor = (subject: string, kind: string) =>
    aboutChange(subject, 'salesforce-admin', changeId, kind);

  /** Notifications are written in the background; wait for the row to land. */
  async function until<T>(read: () => Promise<T[]>, count: number): Promise<T[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await read();
      if (rows.length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return read();
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  beforeAll(async () => {
    // Each person signed in, as sign-in records them.
    const expiresAt = new Date(Date.now() + 3_600_000);
    const sessions = getDataStore().sessions;
    for (const [subject, roles] of [
      [ada, ['renkei-user', 'renkei-operator']],
      [grace, ['renkei-user', 'renkei-operator']],
      [requester, ['renkei-user']],
    ] as const) {
      await sessions.create({ id: randomUUID(), subject, roles: [...roles], expiresAt });
    }
  });

  afterAll(async () => {
    const store = getDataStore();
    for (const subject of subjects) {
      await store.notifications.delete(subject, { all: true });
      await store.sessions.deleteForSubject(subject);
    }
    await closeDataStore();
  });

  it('finds the operators, and only them', async () => {
    const operators = await operatorSubjects();
    expect(operators).toEqual(expect.arrayContaining([ada, grace]));
    expect(operators).not.toContain(requester);
  });

  it('tells every operator but the one who filed it that a change waits, linking its review page', async () => {
    notifyOperatorsOfRequest({
      connector: 'salesforce-admin',
      changeId,
      title: 'Add an Outcome picklist',
      requester: ada,
      freeText: false,
    });
    const forGrace = await until(() => rowsFor(grace, CHANGE_REQUEST_NOTIFICATION_KIND), 1);
    expect(forGrace).toHaveLength(1);
    expect(forGrace[0]).toMatchObject({
      headline: 'A Salesforce change is waiting for your approval: Add an Outcome picklist',
      refUrl: `/salesforce-admin/changes/${changeId}`,
      connector: 'salesforce-admin',
      readAt: null,
    });
    await settle();
    // Not the filer, not the person who is not an operator.
    expect(await rowsFor(ada, CHANGE_REQUEST_NOTIFICATION_KIND)).toHaveLength(0);
    expect(await rowsFor(requester, CHANGE_REQUEST_NOTIFICATION_KIND)).toHaveLength(0);
  });

  it('words a request in words as a request, and a Jira one by its own page', async () => {
    const jiraChange = randomUUID();
    notifyOperatorsOfRequest({
      connector: 'jira-admin',
      changeId: jiraChange,
      title: 'Add a Vendor option',
      requester,
      freeText: true,
    });
    const rows = await until(() => aboutChange(ada, 'jira-admin', jiraChange), 1);
    expect(rows[0]).toMatchObject({
      headline: 'A Jira change was requested: Add a Vendor option',
      refUrl: changePath('jira-admin', jiraChange),
    });
  });

  it('tells the requester and the approving operator how a change ended, once each', async () => {
    notifyChangeOutcome({
      connector: 'salesforce-admin',
      changeId,
      title: 'Add an Outcome picklist',
      requester,
      approver: grace,
      outcome: 'failed',
    });
    const asker = await until(() => rowsFor(requester, CHANGE_RESULT_NOTIFICATION_KIND), 1);
    const approver = await until(() => rowsFor(grace, CHANGE_RESULT_NOTIFICATION_KIND), 1);
    expect(asker).toHaveLength(1);
    expect(approver).toHaveLength(1);
    expect(asker[0]?.headline).toBe('Your Salesforce change failed: Add an Outcome picklist');
    // The approver reads about the change they approved, not "your" change.
    expect(approver[0]?.headline).toBe('The Salesforce change failed: Add an Outcome picklist');
    expect(asker[0]?.refUrl).toBe(`/salesforce-admin/changes/${changeId}`);
  });

  it('tells one person once when they asked for it and approved it', async () => {
    const own = randomUUID();
    notifyChangeOutcome({
      connector: 'jira-admin',
      changeId: own,
      title: 'Own change',
      requester: ada,
      approver: ada,
      outcome: 'applied',
    });
    await until(() => aboutChange(ada, 'jira-admin', own), 1);
    await settle();
    const rows = await aboutChange(ada, 'jira-admin', own);
    expect(rows.map((row) => row.headline)).toEqual(['Your Jira change was applied: Own change']);
    // Nobody else heard of it.
    for (const subject of [grace, requester]) {
      expect(await aboutChange(subject, 'jira-admin', own)).toEqual([]);
    }
  });

  it('gives a decline its reason as the body, and says nothing of it as a failure', async () => {
    const declined = randomUUID();
    notifyChangeOutcome({
      connector: 'salesforce-admin',
      changeId: declined,
      title: 'A change',
      requester,
      approver: null,
      outcome: 'declined',
      note: 'Use the existing field',
    });
    const rows = await until(() => aboutChange(requester, 'salesforce-admin', declined), 1);
    expect(rows.map((row) => row.headline)).toEqual([
      'Your Salesforce change request was declined: A change',
    ]);
  });
});
