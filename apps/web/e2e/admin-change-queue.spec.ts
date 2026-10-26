/**
 * Admin change requests as a queue an operator works through, end to end in
 * a browser, on the Jira side (the stand-in Jira in e2e/sandbox-stub.mjs
 * answers, so a change really applies). Salesforce's pages share the same
 * model and are driven in salesforce-admin.spec.ts.
 *
 * Two people: an operator, and an ordinary person who may ask for a change
 * but not approve one. The ordinary person's proposal and a request in
 * words wait for the operator. The ordinary person sees them, can withdraw
 * their own, and has no approve button; the operator sees everyone's, with
 * who asked. Approving queues the change: the click answers at once, the
 * server applies it, and the operator can leave the page and find it done
 * on the list. A running change shows what it is doing. A declined request
 * shows its reason to the person who asked. The notification rows the
 * server writes open the right page.
 *
 * Own people per project (projects run concurrently against one dev
 * Postgres); the change-request tables are shared by every spec, so
 * assertions here look at this spec's own titles only.
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from './worker-env';
import { Client } from 'pg';
import { enrollForE2E, sealForSubject } from './keys';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);


const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = 'http://127.0.0.1:8092/jira';
const FIELD_ID = 'customfield_10100';
const CONTEXT_ID = '10200';
const FULL_SCOPES = ['read:jira-user', 'read:jira-work', 'manage:jira-configuration'];

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(projectName: string) {
  return {
    operator: {
      sessionId: uuidFrom(`admin-change-queue-e2e-operator:${projectName}`),
      subject: `e2e-queue-operator-${projectName}@example.com`,
      name: 'Olive Operator',
    },
    asker: {
      sessionId: uuidFrom(`admin-change-queue-e2e-asker:${projectName}`),
      subject: `e2e-queue-asker-${projectName}@example.com`,
      name: 'Arlo Asker',
    },
    // Fresh per run: the stub keeps each site's options in memory.
    cloudId: `e2e-queue-cloud-${projectName}-${Date.now()}`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;
type Person = Fixture['operator'];

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function seed(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    const people = [fixture.operator, fixture.asker];
    const subjects = people.map((person) => person.subject);
    await client.query('DELETE FROM jira_admin_change_requests WHERE subject = ANY($1)', [
      subjects,
    ]);
    await client.query('DELETE FROM agent_notifications WHERE subject = ANY($1)', [subjects]);
    await client.query('DELETE FROM audit_events WHERE actor_subject = ANY($1)', [subjects]);
    await client.query('DELETE FROM provider_grants WHERE subject = ANY($1)', [subjects]);
    await client.query('DELETE FROM user_preferences WHERE subject = ANY($1)', [subjects]);
    await client.query('DELETE FROM sessions WHERE subject = ANY($1)', [subjects]);
    await client.query('DELETE FROM identities WHERE subject = ANY($1)', [subjects]);
    await client.query('DELETE FROM connector_configs');
    for (const person of people) {
      await client.query(
        `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
        [
          person.sessionId,
          person.subject,
          person === fixture.operator ? ['renkei-user', 'renkei-operator'] : ['renkei-user'],
          new Date(Date.now() + 24 * 3_600_000),
        ]
      );
      await client.query(
        `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, $3)`,
        [person.subject, person.subject, person.name]
      );
      // Enrolled, so the write-down dialog does not cover the page.
      await enrollForE2E(client, person.subject);
      // No coach marks tour stealing focus mid-screenshot.
      await client.query(
        `INSERT INTO user_preferences (subject, key, value)
         VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
        [person.subject]
      );
      await client.query(
        `INSERT INTO user_preferences (subject, key, value)
         VALUES ($1, 'connectors', '{"added": ["jira-admin"]}'::jsonb)`,
        [person.subject]
      );
    }
    await client.query(
      `INSERT INTO connector_configs (connector, enabled, encrypted_secrets, settings)
       VALUES ('atlassian-admin', true, 'not-a-real-secret', '{}'::jsonb)`
    );
    // Only the operator holds a Jira Administration connection: the deploy runs on theirs.
    await client.query(
      `INSERT INTO provider_grants
         (provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes, metadata)
       VALUES ('atlassian-admin', $7, $1, 'e2e-admin-client', 'Olive Operator', $2, $3, $4, $5, $6)`,
      [
        fixture.operator.subject,
        await sealForSubject(client, fixture.operator.subject, 'e2e-admin-access-token'),
        await sealForSubject(client, fixture.operator.subject, 'e2e-admin-refresh-token'),
        new Date(Date.now() + 365 * 24 * 3_600_000),
        [...FULL_SCOPES, 'offline_access'],
        { cloudId: fixture.cloudId, siteUrl: 'https://e2e.atlassian.net' },
        `e2e-queue-account-${fixture.operator.subject}`,
      ]
    );
  });
}

/** The row jira_admin_propose_option_changes writes (or jira_admin_request_change, for kind 'request'). */
async function file(
  fixture: Fixture,
  by: Person,
  input: {
    title: string;
    kind?: 'field_options' | 'request';
    status?: string;
    step?: string;
    approvedBy?: Person;
    description?: string;
  }
): Promise<string> {
  const kind = input.kind ?? 'field_options';
  const payload =
    kind === 'request'
      ? { description: input.description ?? '' }
      : {
          field: { id: FIELD_ID, name: 'Source', type: 'select list (single choice)' },
          context: { id: CONTEXT_ID, name: 'Ops context', global: false, spaces: ['OPS'] },
          parent: null,
          operations: [{ op: 'add', values: ['Vendor'] }],
        };
  const result = await withDb((client) =>
    client.query<{ id: string }>(
      `INSERT INTO jira_admin_change_requests
         (subject, cloud_id, site_url, kind, title, reason, payload, status, step,
          approved_by, approved_at, expires_at)
       VALUES ($1, $2, 'https://e2e.atlassian.net', $3, $4, 'Procurement tags vendor tickets',
               $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        by.subject,
        fixture.cloudId,
        kind,
        input.title,
        JSON.stringify(payload),
        input.status ?? 'pending',
        input.step ?? null,
        input.approvedBy?.subject ?? null,
        input.approvedBy ? new Date() : null,
        new Date(Date.now() + 24 * 3_600_000),
      ]
    )
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no change request inserted');
  return id;
}

async function rowOf(id: string) {
  const result = await withDb((client) =>
    client.query<{ status: string; approved_by: string | null; resolution: string | null }>(
      'SELECT status, approved_by, resolution FROM jira_admin_change_requests WHERE id = $1',
      [id]
    )
  );
  return result.rows[0];
}

async function liveOptions(fixture: Fixture): Promise<string[]> {
  const response = await fetch(
    `${STUB}/${fixture.cloudId}/rest/api/3/field/${FIELD_ID}/context/${CONTEXT_ID}/option`
  );
  const body: unknown = await response.json();
  const values: unknown[] =
    typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return values.map((option) => {
    const record: Record<string, unknown> =
      typeof option === 'object' && option !== null
        ? Object.fromEntries(Object.entries(option))
        : {};
    return String(record.value);
  });
}

async function signInAs(page: Page, person: Person): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: 'renkei_session',
      value: person.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

const main = (page: Page) => page.getByRole('main');

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// Each test visits several pages that `next dev` compiles on first sight.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

// The tables are shared and an operator's views count everyone's: leave nothing pending behind.
// eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures object first
test.afterEach(async ({}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  const subjects = [fixture.operator.subject, fixture.asker.subject];
  await withDb(async (client) => {
    await client.query('DELETE FROM jira_admin_change_requests WHERE subject = ANY($1)', [
      subjects,
    ]);
    await client.query('DELETE FROM agent_notifications WHERE subject = ANY($1)', [subjects]);
  });
});

test('an ordinary person asks and follows; an operator sees who asked and declines with a reason', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  const proposal = await file(fixture, fixture.asker, {
    title: 'Queue: add the option “Vendor” to Source',
  });
  const words = await file(fixture, fixture.asker, {
    title: 'Queue: please add a Reseller option',
    kind: 'request',
    description: 'The Source field in OPS needs a Reseller option for partner tickets.',
  });

  // --- The person who asked: their own, waiting for an operator, nothing to approve. ---
  await signInAs(page, fixture.asker);
  await page.goto('/jira-admin/changes');
  await expect(page.getByRole('heading', { name: 'Waiting for an operator' })).toBeVisible();
  const waiting = main(page).getByTestId('changes-waiting');
  await expect(waiting.getByRole('link', { name: /add the option “Vendor”/ })).toBeVisible();
  await expect(waiting.getByRole('link', { name: /add a Reseller option/ })).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-01-asker-list');

  await waiting.getByRole('link', { name: /add the option “Vendor”/ }).click();
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).getByTestId('change-requester')).toContainText('by you');
  await expect(main(page).getByText(/An operator reviews and approves changes to Jira/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline it' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw it' })).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-02-asker-review');

  // The route holds the line, whatever the page shows.
  const refused = await page.request.post(`/api/jira-admin/changes/${proposal}/apply`);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toMatch(/operator/);
  expect((await rowOf(proposal))?.status).toBe('pending');

  // A request in words says what was asked, and offers nothing to approve.
  await page.goto(`/jira-admin/changes/${words}`);
  await expect(main(page).getByTestId('change-request-text')).toContainText(
    'needs a Reseller option for partner tickets'
  );

  // Mobile: the same pages at phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'admin-change-queue-03-asker-request-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- The operator: everyone's, with who asked; a request in words cannot be approved. ---
  await signInAs(page, fixture.operator);
  await page.goto('/jira-admin/changes');
  await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  const operatorWaiting = main(page).getByTestId('changes-waiting');
  const row = operatorWaiting.getByRole('link', { name: /add a Reseller option/ });
  await expect(row).toContainText('Requested');
  await expect(row).toContainText('by Arlo Asker');
  await shot(page, testInfo, 'admin-change-queue-04-operator-list');

  await row.click();
  await expect(main(page).getByTestId('change-request-text')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  const notApprovable = await page.request.post(`/api/jira-admin/changes/${words}/apply`);
  expect(notApprovable.status()).toBe(409);
  expect((await notApprovable.json()).error).toMatch(/request in words/);

  // --- Declining asks for a reason, and the person who asked reads it. ---
  await page.getByRole('button', { name: 'Decline it' }).click();
  await page.getByLabel('Why (the requester reads this)').fill('Use the existing Partner option');
  await page.getByRole('button', { name: 'Send the decline' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Cancelled', {
    timeout: 30_000,
  });
  expect((await rowOf(words))?.resolution).toBe('Use the existing Partner option');

  await signInAs(page, fixture.asker);
  await page.goto(`/jira-admin/changes/${words}`);
  await expect(main(page).getByTestId('change-resolution')).toContainText(
    'Use the existing Partner option'
  );
  await shot(page, testInfo, 'admin-change-queue-05-asker-declined');

  // The ordinary person withdraws their own proposal.
  await page.goto(`/jira-admin/changes/${proposal}`);
  await page.getByRole('button', { name: 'Withdraw it' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Cancelled', {
    timeout: 30_000,
  });
  expect((await rowOf(proposal))?.status).toBe('cancelled');
});

test('approving queues the change, the server applies it, and the operator need not stay', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  const id = await file(fixture, fixture.asker, {
    title: 'Queue: add the option “Vendor” to Source (approved)',
  });
  const before = await liveOptions(fixture);

  await signInAs(page, fixture.operator);
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-requester')).toContainText('by Arlo Asker');
  await shot(page, testInfo, 'admin-change-queue-06-operator-review');

  // The click answers at once with 202: nothing runs inside the request.
  const approve = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/jira-admin/changes/${id}/apply`) &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Approve and apply this change to Jira' }).click();
  expect((await approve).status()).toBe(202);
  await expect(page.getByTestId('change-queued')).toContainText('you can leave this page');
  await expect(page.getByRole('link', { name: 'See all change requests' }).first()).toBeVisible();

  // Leave without waiting: the list follows it to the end by itself.
  await page.goto('/jira-admin/changes');
  const ours = main(page).getByRole('link', { name: /add the option “Vendor” to Source \(approved\)/ });
  await expect(ours.getByTestId('change-state')).toHaveText('Applied', { timeout: 60_000 });
  const row = await rowOf(id);
  expect(row?.status).toBe('applied');
  // It ran on the operator's connection, and Jira really has the option.
  expect(row?.approved_by).toBe(fixture.operator.subject);
  expect(await liveOptions(fixture)).toEqual(expect.arrayContaining([...before, 'Vendor']));

  // The page says who asked, who approved, and what ran.
  await ours.click();
  await expect(main(page).getByTestId('change-approver')).toContainText('by you');
  await expect(main(page).getByTestId('change-requester')).toContainText('by Arlo Asker');
  await expect(main(page).getByTestId('change-operations').getByText('Done')).toHaveCount(1);
  await shot(page, testInfo, 'admin-change-queue-07-applied');

  // The audit trail names the operator and the person who asked.
  await expect
    .poll(async () =>
      withDb(async (client) => {
        const rows = await client.query<{ actor_subject: string; details: { requestedBy: string } }>(
          `SELECT actor_subject, details FROM audit_events
            WHERE action = 'jira_admin.change_applied' AND actor_subject = $1`,
          [fixture.operator.subject]
        );
        return rows.rows.map((r) => `${r.actor_subject} for ${r.details.requestedBy}`);
      })
    )
    .toEqual([`${fixture.operator.subject} for ${fixture.asker.subject}`]);

  // Both people were told how it ended; the rows open the review page.
  await expect
    .poll(async () =>
      withDb(async (client) => {
        const rows = await client.query<{ subject: string; headline: string }>(
          `SELECT subject, headline FROM agent_notifications
            WHERE ref_id = $1 AND kind = 'change_result' ORDER BY subject`,
          [id]
        );
        return rows.rows.map((r) => `${r.subject}: ${r.headline}`);
      })
    )
    .toEqual([
      `${fixture.asker.subject}: Your Jira change was applied: Queue: add the option “Vendor” to Source (approved)`,
      `${fixture.operator.subject}: The Jira change was applied: Queue: add the option “Vendor” to Source (approved)`,
    ]);
  await signInAs(page, fixture.asker);
  await page.goto('/notifications');
  const note = main(page).getByText(/Your Jira change was applied/);
  await expect(note).toBeVisible();
  // Its own icon, not Jira's logo: it must not read as another Jira event.
  await expect(main(page).getByTestId('change-notification-icon').first()).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-08-asker-notified');
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
});

test('a running change shows what it is doing, and survives a visit to another page', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  // As the job leaves it: approved, applying, with its latest step.
  const id = await file(fixture, fixture.asker, {
    title: 'Queue: a change still running',
    status: 'applying',
    step: 'Applying the change in Jira',
    approvedBy: fixture.operator,
  });

  await signInAs(page, fixture.operator);
  await page.goto(`/jira-admin/changes/${id}`);
  const progress = main(page).getByTestId('change-progress');
  await expect(progress).toContainText('Applying');
  await expect(main(page).getByTestId('change-step')).toHaveText('Applying the change in Jira');
  await expect(progress).toContainText('You can leave this page and come back');
  await expect(page.getByRole('button', { name: /Approve|Decline/ })).toHaveCount(0);
  await shot(page, testInfo, 'admin-change-queue-09-running');

  // The list shows it under "Running now", with the same step.
  await page.goto('/jira-admin/changes');
  const running = main(page).getByTestId('changes-running');
  await expect(running.getByRole('link', { name: /a change still running/ })).toContainText(
    'Applying the change in Jira'
  );
  await shot(page, testInfo, 'admin-change-queue-10-running-list');

  // The person who asked can follow it too.
  await signInAs(page, fixture.asker);
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-progress')).toBeVisible();

  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'admin-change-queue-11-running-mobile');
});

test('the notification rows for a waiting request and a finished change open the right page', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  const id = await file(fixture, fixture.asker, { title: 'Queue: add “Vendor” (waiting)' });
  // As notifyOperatorsOfRequest writes it, for the operator.
  await withDb((client) =>
    client.query(
      `INSERT INTO agent_notifications (id, subject, kind, connector, entity, headline, ref_id, ref_url)
       VALUES ($1, $2, 'change_request', 'jira-admin', 'change request', $3, $4, $5)`,
      [
        uuidFrom(`admin-change-queue-note:${testInfo.project.name}`),
        fixture.operator.subject,
        'A Jira change is waiting for your approval: Queue: add “Vendor” (waiting)',
        id,
        `/jira-admin/changes/${id}`,
      ]
    )
  );

  await signInAs(page, fixture.operator);
  await page.goto('/notifications');
  const note = main(page).getByText('A Jira change is waiting for your approval');
  await expect(note).toBeVisible();
  await expect(main(page).getByTestId('change-notification-icon')).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-12-notification');
  // The headline is the row's link, stretched over the whole card.
  await main(page).getByRole('link', { name: /A Jira change is waiting for your approval/ }).click();
  await expect(page).toHaveURL(new RegExp(`/jira-admin/changes/${id}$`), { timeout: 30_000 });
  await expect(main(page).getByTestId('change-title')).toHaveText(
    'Queue: add “Vendor” (waiting)'
  );
});
