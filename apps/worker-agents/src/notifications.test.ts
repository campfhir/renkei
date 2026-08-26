/**
 * The notifier against a real database (skipped without DATABASE_URL).
 *
 * The case that carries the weight is the NEGATIVE one: preferences are
 * applied at write time, so a category somebody switched off must produce
 * no row at all. Getting that backwards does not hide a notification — it
 * writes one that should never have existed, into a table whose whole
 * argument for being separate is that it stays small.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { ACT_META_KEY } from '@renkei/tool-outcomes';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs';
import { createNotifier } from './notifications';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('agent notifications', () => {
  jest.setTimeout(20_000);

  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const agentId = randomUUID();
  const runId = randomUUID();

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `notif-test-${tenantId.slice(0, 8)}` })
      .execute();
    // The agent and the run have to exist: a notification points at both by
    // foreign key, so that a deleted agent nulls the reference and a pruned
    // run takes its notifications with it.
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: subject,
        name: 'Triage bot',
        steps: JSON.stringify({ version: 1, steps: [] }),
        enabled: true,
      })
      .execute();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: subject,
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify({ version: 1, steps: [] }),
      })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_notifications WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  beforeEach(async () => {
    await sql`DELETE FROM agent_notifications WHERE tenant_id = ${tenantId}`.execute(db);
  });

  const notifier = (prefs: Partial<NotificationPrefs> = {}) =>
    createNotifier(db, {
      tenantId,
      subject,
      agentId,
      // Denormalized: the row keeps the name even after the agent is gone.
      agentName: 'Triage bot',
      runId,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, ...prefs },
    });

  const rows = () =>
    db
      .selectFrom('agent_notifications')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .execute();

  it('records a curated act with its identifier and link', async () => {
    await notifier().act(
      'jira_create_issue',
      'act',
      {
        [ACT_META_KEY]: {
          id: 'PROJ-42',
          url: 'https://example.atlassian.net/browse/PROJ-42',
        },
      },
      'step-1'
    );

    const [row] = await rows();
    expect(row?.headline).toBe('Created a Jira issue PROJ-42');
    expect(row?.kind).toBe('act');
    expect(row?.category).toBe('created');
    expect(row?.connector).toBe('jira');
    expect(row?.tool).toBe('jira_create_issue');
    expect(row?.entity).toBe('issue');
    expect(row?.ref_id).toBe('PROJ-42');
    expect(row?.ref_url).toBe('https://example.atlassian.net/browse/PROJ-42');
    expect(row?.step_id).toBe('step-1');
    expect(row?.agent_name).toBe('Triage bot');
    // Unread is the arrival state; the badge counts on it.
    expect(row?.read_at).toBeNull();
  });

  it('writes NOTHING for a read', async () => {
    await notifier().act('jira_get_issue', 'read', {}, null);
    expect(await rows()).toHaveLength(0);
  });

  it('writes NOTHING for a category the person switched off', async () => {
    await notifier({ acts: { jira: { created: false } } }).act(
      'jira_create_issue',
      'act',
      {},
      null
    );
    expect(await rows()).toHaveLength(0);
  });

  it('writes NOTHING for an uncurated act by default', async () => {
    // 'other' is off out of the box, which is what keeps the ~110 uncurated
    // act tools from burying the ones that say something.
    await notifier().act('jira_add_attachment', 'act', {}, null);
    expect(await rows()).toHaveLength(0);
  });

  it('writes an uncurated act once somebody asks for them', async () => {
    await notifier({ acts: { jira: { other: true } } }).act('jira_add_attachment', 'act', {}, null);
    const [row] = await rows();
    expect(row?.headline).toBe('Ran jira add attachment');
    expect(row?.category).toBe('other');
  });

  it('lets a per-tool switch beat the category', async () => {
    await notifier({ tools: { jira_create_issue: false } }).act(
      'jira_create_issue',
      'act',
      {},
      null
    );
    expect(await rows()).toHaveLength(0);
  });

  it('stays quiet about a run starting unless asked', async () => {
    await notifier().runStarted();
    expect(await rows()).toHaveLength(0);

    await notifier({ runStarted: true }).runStarted();
    const [row] = await rows();
    expect(row?.kind).toBe('run_started');
    expect(row?.headline).toContain('Triage bot');
  });

  it('records a finish and a failure, and names the failure', async () => {
    await notifier().runFinished('succeeded', null);
    await notifier().runFinished('failed', 'the tool refused');
    const found = await rows();
    expect(found.map((row) => row.kind)).toEqual(['run_finished', 'run_failed']);
    expect(found[1]?.headline).toContain('the tool refused');
  });

  it('never throws when the write fails', async () => {
    // A tenant that does not exist violates the FK. The act already
    // happened, so this must be a warning and not an exception climbing
    // back into the run loop.
    const orphan = createNotifier(db, {
      tenantId: randomUUID(),
      subject,
      agentId,
      agentName: 'Ghost',
      runId,
      prefs: DEFAULT_NOTIFICATION_PREFS,
    });
    await expect(orphan.act('jira_create_issue', 'act', {}, null)).resolves.toBeUndefined();
  });
});
