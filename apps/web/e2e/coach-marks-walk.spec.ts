/**
 * Every tour in the registry, walked: started by id on the page it
 * belongs on, stepped through to Finish, each step captured under
 * test-results/screens/<project>/tour-<id>-<n>-<step>.png. The pictures
 * are the point — a tour is copy and placement, and the only way to
 * judge either is to look — but the walk also proves each tour's steps
 * come in the order the registry says, and that a step whose target the
 * seeded page carries gets its spotlight.
 *
 * Which page each tour is walked on comes from WALKS below: most start
 * on the tour's own start path, and the ones about a particular record
 * (an agent's page, its runs) use the seed's rich agent. A tour whose
 * page needs data the seed does not have is walked anyway — every step
 * then falls back to the centred card — and says so in `spotlight`.
 *
 * Signs in as the seed's own person — the rich agent's owner, since an
 * agent's page opens only for its owner or someone it is shared with —
 * through a session of its own per project. That person has auto-start
 * off in the seed, so no page's own tour greets the walker before the
 * one it came for. Nothing of theirs is deleted: the other specs are
 * signed in as them too.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { COACH_MARK_TOURS } from '../lib/coach-marks/tours';
import { AGENT_RICH_ID, E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

/** A project and a prompt library of the seed's person, made for the walk and removed after. */
const WALK_PROJECT_ID = '77777777-7777-4777-8777-77777777c0a1';
const WALK_LIBRARY_ID = '77777777-7777-4777-8777-77777777c0a2';

function sessionIdFor(project: string): string {
  const hex = createHash('sha1').update(`coach-marks-walk:${project}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use, testInfo) => {
    await use({
      cookies: [
        {
          name: `renkei_session_${E2E_TENANT_ID}`,
          value: sessionIdFor(testInfo.project.name),
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    });
  },
});

/**
 * Where to walk each tour, and whether its first targeted step should
 * find its target on that page. A tour absent from this map is walked on
 * its own start path with the spotlight expected.
 */
interface Walk {
  path: string;
  /** Whether at least one step should find its target on this page. */
  spotlight: boolean;
  /** The address to wait for first, when `path` redirects (a client-side hop). */
  settle?: RegExp;
  /**
   * What to open on the page before the tour can begin, for a tour pinned
   * to something that is not there on arrival (the catalog modal). Such a
   * tour is asked for the way the Tutorials page asks — a pending request
   * the engine picks up as soon as the anchor mounts — rather than by
   * `?tour=`, which starts at once wherever it is.
   */
  open?: (page: Page) => Promise<void>;
}
const THREAD = /\/chat\/[0-9a-f-]{36}$/;
const WALKS: Record<string, Walk> = {
  'agent-detail': { path: `/${E2E_SLUG}/agents/${AGENT_RICH_ID}`, spotlight: true },
  'agent-runs': { path: `/${E2E_SLUG}/agents/${AGENT_RICH_ID}/runs`, spotlight: true },
  // The seed registers no file shares: the browser shows its empty note.
  files: { path: `/${E2E_SLUG}/files`, spotlight: true },
  chat: { path: `/${E2E_SLUG}/chat/new`, spotlight: true, settle: THREAD },
  'chat-composer-more': { path: `/${E2E_SLUG}/chat/new`, spotlight: true, settle: THREAD },
  // A permission ask exists only while a turn waits on one; walked on a
  // plain thread, every step sits centred.
  'chat-permission': { path: `/${E2E_SLUG}/chat/new`, spotlight: false, settle: THREAD },
  project: { path: `/${E2E_SLUG}/chat/projects/${WALK_PROJECT_ID}`, spotlight: true },
  'prompt-library': { path: `/${E2E_SLUG}/chat/prompts/${WALK_LIBRARY_ID}`, spotlight: true },
  // Code workspaces are off in this environment (SANDBOX_WORKSPACES_ENABLED
  // is unset for the e2e server): the index shows its notice and has no
  // New code project link, and /code/new sends the visitor back to /code.
  code: { path: `/${E2E_SLUG}/code`, spotlight: false },
  'code-new': { path: `/${E2E_SLUG}/code`, spotlight: false },
  // The catalog greets its first opening; the walk opens it.
  'add-connector': {
    path: `/${E2E_SLUG}/connectors`,
    spotlight: true,
    open: (page) => page.getByRole('button', { name: 'Add connector' }).click(),
  },
  // The seed connects Jira, which puts the Atlassian card — Jira and
  // Service Management — on the page. No other product is added, so every
  // other card tour is walked with its steps centred.
  'connect-confluence': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-jira-admin': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-bitbucket': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-github': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-microsoft': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-entra-developer': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-webex': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-zoom': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-onbase': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-onbase-admin': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-fileshares': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'connect-mirth': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  'browser-secrets': { path: `/${E2E_SLUG}/connectors`, spotlight: false },
  // A connector's own page: the seed registers Atlassian.
  'admin-connector-detail': { path: `/${E2E_SLUG}/admin/connectors/atlassian`, spotlight: true },
};

let client: Client;

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO chat_projects (id, tenant_id, owner_subject, name, description, instructions)
     VALUES ($1, $2, $3, 'Tour project', 'A project the tour walk made.', 'Answer briefly.')
     ON CONFLICT (id) DO NOTHING`,
    [WALK_PROJECT_ID, E2E_TENANT_ID, E2E_SUBJECT]
  );
  await client.query(
    `INSERT INTO prompt_libraries (id, tenant_id, owner_subject, name, description)
     VALUES ($1, $2, $3, 'Tour library', 'A library the tour walk made.')
     ON CONFLICT (id) DO NOTHING`,
    [WALK_LIBRARY_ID, E2E_TENANT_ID, E2E_SUBJECT]
  );
  await client.query(
    `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')
     ON CONFLICT (id) DO NOTHING`,
    [
      sessionIdFor(testInfo.project.name),
      E2E_TENANT_ID,
      E2E_SUBJECT,
      ['renkei-user', 'renkei-operator'],
    ]
  );
});

test.afterAll(async () => {
  await client.query('DELETE FROM chat_projects WHERE id = $1', [WALK_PROJECT_ID]);
  await client.query('DELETE FROM prompt_libraries WHERE id = $1', [WALK_LIBRARY_ID]);
  await client.end();
});

async function shot(page: Page, project: string, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({
    path: path.join(import.meta.dirname, '..', 'test-results', 'screens', project, `${name}.png`),
    fullPage: false,
  });
}

for (const tour of COACH_MARK_TOURS) {
  test(`tour: ${tour.id} — ${tour.title}`, async ({ page }, testInfo) => {
    const walk: Walk = WALKS[tour.id] ?? { path: `/${E2E_SLUG}${tour.startPath}`, spotlight: true };
    // Land first, then ask: a start path that redirects ('/chat/new' makes
    // a thread and goes there) would drop the query on the way.
    await page.goto(walk.path);
    if (walk.settle) await page.waitForURL(walk.settle);
    await page.waitForLoadState('domcontentloaded');
    if (walk.open) {
      await page.evaluate(
        (id) => window.sessionStorage.setItem('renkei:coach-mark-pending', `${id}|${Date.now()}`),
        tour.id
      );
      await walk.open(page);
    } else {
      const landed = new URL(page.url());
      landed.searchParams.set('tour', tour.id);
      await page.goto(landed.toString());
    }
    const card = page.getByTestId('coach-mark');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-coach-tour', tour.id);

    // A step's target may be absent by design on this page (the attach
    // button needs storage, the dictation button a voice service), so the
    // check is that the tour lit SOMETHING up, not that every step did.
    let lit = 0;
    for (const [index, step] of tour.steps.entries()) {
      await expect(card).toHaveAttribute('data-coach-step', step.id);
      await expect(card).toContainText(`${index + 1} of ${tour.steps.length}`);
      await shot(page, testInfo.project.name, `tour-${tour.id}-${index + 1}-${step.id}`);
      if (step.target && (await page.getByTestId('coach-mark-spotlight').count()) > 0) lit += 1;
      const last = index === tour.steps.length - 1;
      await card.getByRole('button', { name: last ? 'Finish' : 'Next' }).click();
    }
    await expect(card).toHaveCount(0);
    // Finish sends its completion report as a keepalive fetch, which
    // survives a navigation but not the browser context this test tears
    // down the instant the card is gone; a beat lets it land, so the
    // tutorials report the last walk screenshots shows what a person
    // stepping through would have produced.
    await page.waitForTimeout(400);
    if (walk.spotlight) expect(lit, `${tour.id}: no step found its target`).toBeGreaterThan(0);
  });
}
