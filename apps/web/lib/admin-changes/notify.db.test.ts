/**
 * Telling people about admin change requests, against a real database
 * (skipped without DATABASE_URL): a new request reaches every operator but
 * the one who filed it, and nobody else; how a queued change ended reaches
 * the person who asked and the operator who approved it, once each, with
 * the review page as the place to open.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
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
  let db: Kysely<DB>;
  const suite = randomUUID().slice(0, 8);
  const ada = `ada-${suite}`;
  const grace = `grace-${suite}`;
  const requester = `requester-${suite}`;
  const changeId = randomUUID();
  const subjects = [ada, grace, requester];

  async function rowsFor(subject: string, kind: string) {
    return db
      .selectFrom('agent_notifications')
      .select(['headline', 'ref_url', 'ref_id', 'connector', 'read_at'])
      .where('subject', '=', subject)
      .where('kind', '=', kind)
      .where('ref_id', '=', changeId)
      .execute();
  }

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
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    const expires = new Date(Date.now() + 3_600_000);
    await sql`INSERT INTO sessions (id, subject, roles, expires_at) VALUES
      (${randomUUID()}, ${ada}, ARRAY['renkei-user','renkei-operator'], ${expires}),
      (${randomUUID()}, ${grace}, ARRAY['renkei-user','renkei-operator'], ${expires}),
      (${randomUUID()}, ${requester}, ARRAY['renkei-user'], ${expires})`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_notifications WHERE subject = ANY(${subjects})`.execute(db);
    await sql`DELETE FROM sessions WHERE subject = ANY(${subjects})`.execute(db);
    await closeDatabase();
  });

  it('finds the operators, and only them', async () => {
    const operators = await operatorSubjects(db);
    expect(operators).toEqual(expect.arrayContaining([ada, grace]));
    expect(operators).not.toContain(requester);
  });

  it('tells every operator but the one who filed it that a change waits, linking its review page', async () => {
    notifyOperatorsOfRequest({
      db,
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
      ref_url: `/salesforce-admin/changes/${changeId}`,
      connector: 'salesforce-admin',
      read_at: null,
    });
    await settle();
    // Not the filer, not the person who is not an operator.
    expect(await rowsFor(ada, CHANGE_REQUEST_NOTIFICATION_KIND)).toHaveLength(0);
    expect(await rowsFor(requester, CHANGE_REQUEST_NOTIFICATION_KIND)).toHaveLength(0);
  });

  it('words a request in words as a request, and a Jira one by its own page', async () => {
    const jiraChange = randomUUID();
    notifyOperatorsOfRequest({
      db,
      connector: 'jira-admin',
      changeId: jiraChange,
      title: 'Add a Vendor option',
      requester,
      freeText: true,
    });
    const rows = await until(
      () =>
        db
          .selectFrom('agent_notifications')
          .select(['headline', 'ref_url'])
          .where('subject', '=', ada)
          .where('ref_id', '=', jiraChange)
          .execute(),
      1
    );
    expect(rows[0]).toEqual({
      headline: 'A Jira change was requested: Add a Vendor option',
      ref_url: changePath('jira-admin', jiraChange),
    });
  });

  it('tells the requester and the approving operator how a change ended, once each', async () => {
    notifyChangeOutcome({
      db,
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
    expect(asker[0]?.ref_url).toBe(`/salesforce-admin/changes/${changeId}`);
  });

  it('tells one person once when they asked for it and approved it', async () => {
    const own = randomUUID();
    notifyChangeOutcome({
      db,
      connector: 'jira-admin',
      changeId: own,
      title: 'Own change',
      requester: ada,
      approver: ada,
      outcome: 'applied',
    });
    await until(
      () => db.selectFrom('agent_notifications').select('id').where('ref_id', '=', own).execute(),
      1
    );
    await settle();
    const rows = await db
      .selectFrom('agent_notifications')
      .select('headline')
      .where('ref_id', '=', own)
      .execute();
    expect(rows).toEqual([{ headline: 'Your Jira change was applied: Own change' }]);
  });

  it('gives a decline its reason as the body, and says nothing of it as a failure', async () => {
    const declined = randomUUID();
    notifyChangeOutcome({
      db,
      connector: 'salesforce-admin',
      changeId: declined,
      title: 'A change',
      requester,
      approver: null,
      outcome: 'declined',
      note: 'Use the existing field',
    });
    const rows = await until(
      () =>
        db
          .selectFrom('agent_notifications')
          .select('headline')
          .where('ref_id', '=', declined)
          .execute(),
      1
    );
    expect(rows).toEqual([
      { headline: 'Your Salesforce change request was declined: A change' },
    ]);
  });
});
