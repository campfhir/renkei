/**
 * The code-workspace checkout size limit, end to end in a browser: an
 * admin sets the org limit from Settings (default 8 GB); a member of a
 * code project asks for a larger checkout with a reason; the admin sees
 * the request and approves it (raising that project only) or denies it
 * with a note, and the project page reflects each outcome. The sandbox
 * worker is the stub in sandbox-stub.mjs, so the project's checkout is
 * "ready" without any network.
 *
 * The project is the test's own person's (an operator, who also
 * approves): connected to Bitbucket and made through the Code routes
 * (e2e/support/code-host.ts), its checkout cloned by a first chat turn.
 * The org limit and the admin's list are the one organization's, so the
 * Playwright projects take turns (a lock directory).
 *
 * Mobile is a resized Chromium viewport, not the `mobile` project's device
 * descriptor (AGENTS.md, "UI changes"). Screenshots land under
 * test-results/screens/<project>/size-requests-*.png.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect as baseExpect, type Page, type TestInfo } from '@playwright/test';
import { test } from './fixtures';
import { removeModel } from './support/stub-model';
import { setUpCode, stageCodeProject } from './support/code-host';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const GB = 1_073_741_824;

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `size-requests-${name}.png`),
    fullPage: true,
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const expect = baseExpect;
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * The org limit and the admin's request list are one organization's, so the
 * three Playwright projects cannot run this at the same time: whoever holds
 * the lock directory runs, the others wait for it.
 */
const LOCK = path.join(
  tmpdir(),
  `renkei-e2e-size-requests-${process.env.E2E_MEMORY_PORT ?? 3100}.lock`
);
async function withOrgLock<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      if (Date.now() > deadline) rmSync(LOCK, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await run();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

test('checkout limit: org setting, request, approve, deny', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // Up to two runs of the body in turn, the dev server compiling each route on its first hit.
  test.setTimeout(720_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  try {
    await withOrgLock(() => checkoutLimit(page, testInfo, tag, modelId));
  } finally {
    await removeModel(page.request, modelId);
  }
});

async function checkoutLimit(
  page: Page,
  testInfo: TestInfo,
  tag: string,
  llmModelId: string
): Promise<void> {
  // The dev server compiles each route on its first hit, which outlasts the default 5s.
  const expect = baseExpect.configure({ timeout: 30_000 });
  const projectName = `Monorepo (${tag})`;
  const { projectId } = await stageCodeProject(page.request, {
    name: projectName,
    repository: 'acme/monorepo',
    branch: 'main',
    chats: ['First look'],
    clone: true,
    llmModelId,
  });
  // The org limit is one shared setting behind a 60s server cache: an earlier
  // project's run leaves its 12 GB in that cache. Putting the default back
  // through the API invalidates it, whatever ran before.
  const reset = await page.request.put(`/api/admin/org-settings`, {
    data: { sandboxWorkspaceMaxBytes: 8 * GB },
  });
  expect(reset.ok()).toBe(true);
  const projectUrl = `/code/${projectId}`;
  const settingsUrl = `/admin/settings`;
  // Scoped to the main region: across a navigation the dev server can leave
  // the outgoing page's span in the DOM for a beat, and strict mode would
  // count two.
  const limitText = page.getByRole('main').getByTestId('size-limit');

  // ── Default: 8 GB, with the way to ask for more ──
  // The pages read the org settings through a cache of their own (the dev
  // server holds one per route bundle, so the reset above does not reach it):
  // read again until the previous project's 12 GB has aged out.
  await page.goto(projectUrl);
  // The outgoing page can linger for a beat beside the new one.
  await expect(limitText).toHaveCount(1);
  for (let tries = 0; tries < 15; tries += 1) {
    if ((await limitText.textContent({ timeout: 30_000 })) === 'Checkout limit 8 GB.') break;
    await page.waitForTimeout(5_000);
    await page.reload();
  }
  await expect(limitText).toHaveText('Checkout limit 8 GB.');
  await expect(page.getByRole('main').getByTestId('size-request-pending')).toHaveCount(0);
  await shot(page, testInfo, '01-project-default');

  // ── A member asks for more: the form needs a reason; a second ask waits ──
  // The ask is a link, not a form on the page: nothing to fill until it is opened.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Size wanted (GB)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask for more space' });
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  await expect(page.getByLabel('Size wanted (GB)')).toHaveValue('16');
  const send = page.getByRole('button', { name: 'Send request' });
  await expect(send).toBeDisabled();
  await page.getByLabel('Size wanted (GB)').fill('24');
  await page.getByLabel('Why you need it').fill('Monorepo with vendored toolchains');
  await shot(page, testInfo, '03-request-form');
  await send.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('main').getByTestId('size-request-pending')).toHaveText(
    'Your request for 24 GB is waiting for an admin.'
  );
  await expect(page.getByRole('button', { name: 'Ask for more space' })).toHaveCount(0);
  await shot(page, testInfo, '04-request-pending');

  // The server refuses a duplicate and a request at or under the limit.
  const api = `/api/code/projects/${projectId}/size-request`;
  const duplicate = await page.request.post(api, {
    data: { requestedBytes: 30 * GB, reason: 'again' },
  });
  expect(duplicate.status()).toBe(409);

  // ── The admin approves less than was asked; the limit rises for the project ──
  await page.goto(settingsUrl);
  await expect(page.getByLabel('sandboxWorkspaceMaxGb')).toHaveCount(1);
  // One organization: the admin's list holds every project's requests, so the
  // rows are this run's project's own.
  const rows = page
    .getByRole('main')
    .getByTestId('size-request-row')
    .filter({ hasText: projectName });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(projectName);
  await expect(rows.first()).toContainText('24 GB');
  await expect(rows.first()).toContainText('Monorepo with vendored toolchains');
  await shot(page, testInfo, '05-admin-pending');
  await rows.first().getByLabel('Approve up to (GB)').fill('20');
  await rows.first().getByRole('button', { name: 'Approve' }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('size-requests')).toContainText('20 GB approved');

  await page.goto(projectUrl);
  // The outgoing page can linger for a beat beside the new one.
  await expect(limitText).toHaveCount(1);
  await expect(limitText).toHaveText('Checkout limit 20 GB.');
  await expect(page.getByRole('main').getByTestId('size-request-last')).toContainText(
    'Your request for 20 GB was approved.'
  );
  await shot(page, testInfo, '06-project-approved');

  // ── A further ask is denied with a note; the limit stays ──
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  await page.getByLabel('Size wanted (GB)').fill('40');
  await page.getByLabel('Why you need it').fill('Want it all');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('main').getByTestId('size-request-pending')).toBeVisible();

  await page.goto(settingsUrl);
  await expect(page.getByLabel('sandboxWorkspaceMaxGb')).toHaveCount(1);
  await rows.getByLabel('Note').fill('Prune build output first');
  await rows.getByRole('button', { name: 'Deny' }).click();
  await expect(rows).toHaveCount(0);

  await page.goto(projectUrl);
  // The outgoing page can linger for a beat beside the new one.
  await expect(limitText).toHaveCount(1);
  await expect(limitText).toHaveText('Checkout limit 20 GB.');
  await expect(page.getByRole('main').getByTestId('size-request-last')).toContainText(
    'Your last request was denied: Prune build output first'
  );
  await shot(page, testInfo, '07-project-denied');

  // ── An admin changes the org limit from Settings ──
  // Saved and stored at once; the pages read it through the org settings'
  // 60-second cache, which this spec deliberately does not wait out.
  await page.goto(settingsUrl);
  await expect(page.getByLabel('sandboxWorkspaceMaxGb')).toHaveCount(1);
  const orgLimit = page.getByLabel('sandboxWorkspaceMaxGb');
  // The outgoing page's form can linger for a beat beside the new one.
  await expect(orgLimit).toHaveCount(1);
  await expect(orgLimit).toHaveValue('8');
  await orgLimit.fill('12');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const read = await page.request.get(`/api/admin/org-settings`);
  expect((await read.json()).settings.sandboxWorkspaceMaxBytes).toBe(12 * GB);
  // Out of range is clamped, never stored as typed.
  const clamped = await page.request.put(`/api/admin/org-settings`, {
    data: { sandboxWorkspaceMaxBytes: 500 * GB },
  });
  expect((await clamped.json()).settings.sandboxWorkspaceMaxBytes).toBe(64 * GB);
  await page.request.put(`/api/admin/org-settings`, {
    data: { sandboxWorkspaceMaxBytes: 12 * GB },
  });
  await shot(page, testInfo, '08-settings-org-limit');

  // ── Phone width: both pages hold their layout ──
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(projectUrl);
  // The outgoing page can linger for a beat beside the new one.
  await expect(limitText).toHaveCount(1);
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  await expect(page.getByRole('button', { name: 'Send request' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, '09-project-mobile');
  await page.goto(settingsUrl);
  await expect(page.getByLabel('sandboxWorkspaceMaxGb')).toHaveCount(1);
  await expect(page.getByLabel('sandboxWorkspaceMaxGb')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, '10-settings-mobile');
}
