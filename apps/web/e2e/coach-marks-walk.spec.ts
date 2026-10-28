/**
 * Every tour in the registry, walked: started by id on the page it
 * belongs on, stepped through to Finish, each step captured under
 * test-results/screens/<project>/tour-<id>-<n>-<step>.png. The pictures
 * are the point — a tour is copy and placement, and the only way to
 * judge either is to look — but the walk also proves each tour's steps
 * come in the order the registry says, and that a step whose target the
 * staged page carries gets its spotlight.
 *
 * Which page each tour is walked on comes from WALKS below: most start
 * on the tour's own start path, and the ones about a particular record
 * (an agent's page, its runs, a project, a prompt library) stage that
 * record for the test's own person through the routes the UI uses — a
 * code project's chat among them, on a Bitbucket the person connects
 * through the in-memory app's fake OAuth (e2e/support/code-host.ts). A
 * tour whose page needs data the memory server has no way to make (a
 * pending permission ask) is walked anyway — every step then falls back
 * to the centred card — and says so in `spotlight`.
 *
 * Each test signs in a person of its own, with auto-start off, so no
 * page's own tour greets the walker before the one it came for. The tours
 * switch is organization-wide: each test holds the suite's shared lock on
 * it (coach-marks-off.spec.ts flips it).
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { COACH_MARK_TOURS } from '../lib/coach-marks/tours';
import { createAgent, runAgent } from './support/agents';
import { addStubModel, removeModel } from './support/stub-model';
import { holdShared, type Release } from './support/org-lock';
import {
  connectCodeHost,
  prepareCodeHost,
  setUpCode,
  stageCodeProject,
  type CodeHost,
} from './support/code-host';
import {
  addConnectors,
  connectJira,
  connectThrough,
  registerConnector,
} from './support/connectors';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

// The console tours are an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function created(
  response: Awaited<ReturnType<Page['request']['post']>>,
  key: string
): Promise<string> {
  expect(response.status(), await response.text()).toBe(201);
  const body: unknown = await response.json();
  const value =
    typeof body === 'object' && body !== null
      ? Object.entries(body).find(([name]) => name === key)?.[1]
      : null;
  return String(value);
}

/** Models a test put on the org's roster, taken off again after it. */
let staged: string[] = [];

/**
 * An agent of the person's own that has run once (its page's runs card
 * and the runs page's filters show only then), run on the stand-in model.
 */
async function stageAgent(page: Page): Promise<string> {
  const modelId = await addStubModel(page.request, `tour-${randomUUID().slice(0, 8)}`);
  staged.push(modelId);
  const agentId = await createAgent(page.request, {
    name: `Tour agent ${randomUUID().slice(0, 8)}`,
    instructions: '## Goal\n\nTriage yesterday into tickets.',
    llmModelId: modelId,
  });
  await runAgent(page.request, agentId);
  await expect(async () => {
    await page.goto(`/agents/${agentId}/runs`);
    await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 45_000 });
  return agentId;
}

/**
 * Where to walk each tour, and whether its first targeted step should
 * find its target on that page. A tour absent from this map is walked on
 * its own start path with the spotlight expected.
 */
interface Walk {
  /** Where to land, or how to stage what the page is about and where it is. */
  path: string | ((page: Page, request: APIRequestContext) => Promise<string>);
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
  /**
   * Why the tour cannot start on anything the memory server can stage: it
   * needs an anchor that only mounts on a record a vendor's grant makes.
   */
  unreachable?: string;
}
const THREAD = /\/chat\/[0-9a-f-]{36}$/;

/** Connect something for the person, then walk on their Connectors page. */
function onConnectors(
  connect: (page: Page, request: APIRequestContext) => Promise<void>
): (page: Page, request: APIRequestContext) => Promise<string> {
  return async (page, request) => {
    await connect(page, request);
    return '/connectors';
  };
}
const atlassianApp = (connector: string) => async (page: Page) => {
  await registerConnector(page.request, connector, {
    clientId: `e2e-${connector}-client`,
    clientSecret: `e2e-${connector}-secret`,
  });
  await connectThrough(page, `/api/${connector}/authorize`);
};
const codeHost = (which: CodeHost) => async (page: Page, request: APIRequestContext) => {
  await prepareCodeHost(request);
  await connectCodeHost(page, which);
};
async function microsoft(page: Page): Promise<void> {
  await registerConnector(
    page.request,
    'microsoft',
    {
      clientId: 'e2e-microsoft-client',
      clientSecret: 'e2e-microsoft-secret',
      directoryTenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    },
    ['directoryTenantId']
  );
  await addConnectors(page.request, ['microsoft']);
  await connectThrough(page, '/api/microsoft/authorize');
}
const WALKS: Record<string, Walk> = {
  'agent-detail': {
    path: async (page) => `/agents/${await stageAgent(page)}`,
    spotlight: true,
  },
  'agent-runs': {
    path: async (page) => `/agents/${await stageAgent(page)}/runs`,
    spotlight: true,
  },
  // No file shares are registered for the person: the browser shows its empty note.
  files: { path: `/files`, spotlight: true },
  chat: { path: `/chat/new`, spotlight: true, settle: THREAD },
  'chat-composer-more': { path: `/chat/new`, spotlight: true, settle: THREAD },
  // A permission ask exists only while a turn waits on one; walked on a
  // plain thread, every step sits centred.
  'chat-permission': { path: `/chat/new`, spotlight: false, settle: THREAD },
  project: {
    path: async (page) => {
      const projectId = await created(
        await page.request.post('/api/chat/projects', {
          data: {
            name: 'Tour project',
            description: 'A project the tour walk made.',
            instructions: 'Answer briefly.',
          },
        }),
        'projectId'
      );
      return `/chat/projects/${projectId}`;
    },
    spotlight: true,
  },
  'prompt-library': {
    path: async (page) => {
      const libraryId = await created(
        await page.request.post('/api/chat/prompt-libraries', {
          data: { name: 'Tour library', description: 'A library the tour walk made.' },
        }),
        'libraryId'
      );
      return `/chat/prompts/${libraryId}`;
    },
    spotlight: true,
  },
  // No Bitbucket or GitHub is connected for the person: the index shows
  // its access notice and has no New code project link, and /code/new
  // has nothing to offer.
  code: { path: `/code`, spotlight: false },
  // Starts only where the file tree's "new file" button is mounted: a code
  // project's chat, cloned by its first turn, on a connected Bitbucket.
  'code-tree': {
    path: async (page, request) => {
      const tag = randomUUID().slice(0, 8);
      const modelId = await setUpCode(page, request, `tour-${tag}`);
      staged.push(modelId);
      const { chatIds } = await stageCodeProject(page.request, {
        name: `Tour code project (${tag})`,
        repository: 'acme/billing-service',
        branch: 'main',
        chats: [`Tour code chat (${tag})`],
        clone: true,
        llmModelId: modelId,
      });
      return `/chat/${chatIds[0]}`;
    },
    spotlight: true,
  },
  'code-new': { path: `/code`, spotlight: false },
  // The catalog greets its first opening; the walk opens it.
  'add-connector': {
    path: `/connectors`,
    spotlight: true,
    open: (page) => page.getByRole('button', { name: 'Add connector' }).click(),
  },
  // The card tours of the products a person connects with a sign-in of
  // their own: connected first (the in-memory app's fake OAuth), so the
  // card is on the page for the tour to light up.
  'connect-jira': { path: onConnectors((page) => connectJira(page)), spotlight: true },
  'connect-jsm': { path: onConnectors(atlassianApp('atlassian-jsm')), spotlight: true },
  'connect-confluence': {
    path: onConnectors(atlassianApp('atlassian-confluence')),
    spotlight: true,
  },
  'connect-bitbucket': { path: onConnectors(codeHost('bitbucket')), spotlight: true },
  'connect-github': { path: onConnectors(codeHost('github')), spotlight: true },
  'connect-microsoft': { path: onConnectors(microsoft), spotlight: true },
  // The rest are walked on a page without their card, every step centred.
  'connect-salesforce-admin': { path: `/connectors`, spotlight: false },
  'connect-jira-admin': { path: `/connectors`, spotlight: false },
  'connect-entra-developer': { path: `/connectors`, spotlight: false },
  'connect-salesforce': { path: `/connectors`, spotlight: false },
  'connect-webex': { path: `/connectors`, spotlight: false },
  'connect-zoom': { path: `/connectors`, spotlight: false },
  'connect-onbase': { path: `/connectors`, spotlight: false },
  'connect-onbase-admin': { path: `/connectors`, spotlight: false },
  'connect-fileshares': { path: `/connectors`, spotlight: false },
  'connect-mirth': { path: `/connectors`, spotlight: false },
  'browser-secrets': { path: `/connectors`, spotlight: false },
  // A connector's own page: the seed registers Atlassian.
  'admin-connector-detail': { path: `/admin/connectors/atlassian`, spotlight: true },
};

let release: Release | undefined;
test.beforeEach(async () => {
  // The lock can be held for a while by the spec that switches tours off.
  test.setTimeout(300_000);
  release = await holdShared('tours');
});
test.afterEach(async ({ page }) => {
  for (const modelId of staged) await removeModel(page.request, modelId);
  staged = [];
  await release?.();
});

async function shot(page: Page, project: string, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({
    path: path.join(RESULTS, 'screens', project, `${name}.png`),
    fullPage: false,
  });
}

for (const tour of COACH_MARK_TOURS) {
  test(`tour: ${tour.id} — ${tour.title}`, async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(120_000);
    const walk: Walk = WALKS[tour.id] ?? { path: tour.startPath, spotlight: true };
    test.skip(walk.unreachable !== undefined, walk.unreachable);
    const landing = typeof walk.path === 'string' ? walk.path : await walk.path(page, request);
    // Land first, then ask: a start path that redirects ('/chat/new' makes
    // a thread and goes there) would drop the query on the way.
    await page.goto(landing);
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
    // A page's first visit compiles it on a dev server.
    await expect(card).toBeVisible({ timeout: 30_000 });
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
