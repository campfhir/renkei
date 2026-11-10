/**
 * The code-workspace checkout size limit in a browser: a member of a code
 * project opens "Ask for more space", sends a size and a reason, and the
 * project page draws the waiting request — the one press that goes end to
 * end (dialog → POST …/size-request → the page refreshed). The admin's
 * Settings page then lists it, and both pages hold their layout at a
 * phone's width. The sandbox worker is the stub in sandbox-stub.mjs, so the
 * project's checkout is "ready" without any network.
 *
 * Where the rest went: the dialog's rules (closed until asked, twice the
 * limit to start, Send off without a reason, what it sends, the lines for a
 * waiting, approved or denied request) are size-request.model.test.ts; the
 * admin row's (what Approve and Deny send, the recently-decided lines) are
 * admin/settings/size-requests.model.test.ts; the server's — a duplicate
 * refused with 409, at or under the limit and over 64 GB refused, an
 * approval raising that project only, a denial's note, a request decided
 * twice — are route tests beside api/code/projects/[projectId]/size-request
 * and api/admin/sandbox-size-requests/[id]; the org limit's GB field and its
 * clamp are settings-form.model.test.ts and api/admin/org-settings.
 *
 * The project is the test's own person's (an operator, who also sees the
 * admin list): connected to Bitbucket and made through the Code routes
 * (e2e/support/code-host.ts), its checkout cloned by a first chat turn. The
 * org limit is put back to its default, written the same by everyone, and
 * the request is denied through the admin route afterwards. Mobile is a
 * resized viewport. Screenshots land under
 * test-results/screens/<project>/size-requests-*.png.
 */

import { randomUUID } from 'node:crypto';
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
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  baseExpect(overflow).toBeLessThanOrEqual(0);
}

test('checkout limit: a member asks for more, the admin sees it', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(480_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  try {
    await checkoutLimit(page, testInfo, tag, modelId);
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
  // The default org limit, written the same by everyone.
  const reset = await page.request.put(`/api/admin/org-settings`, {
    data: { sandboxWorkspaceMaxBytes: 8 * GB },
  });
  expect(reset.ok()).toBe(true);
  const projectUrl = `/code/${projectId}`;
  const settingsUrl = `/admin/settings`;
  // Scoped to the main region: across a navigation the dev server can leave
  // the outgoing page's span in the DOM for a beat, and strict mode would
  // count two.
  const main = page.getByRole('main');
  const limitText = main.getByTestId('size-limit');

  // ── The project page: 8 GB, with the way to ask for more ──
  await page.goto(projectUrl);
  await expect(limitText).toHaveCount(1);
  await expect(limitText).toHaveText('Checkout limit 8 GB.');
  await shot(page, testInfo, '01-project-default');

  // ── The one press end to end: ask, send, the page draws the waiting request ──
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask for more space' });
  await expect(dialog).toBeVisible();
  await page.getByLabel('Size wanted (GB)').fill('24');
  await page.getByLabel('Why you need it').fill('Monorepo with vendored toolchains');
  await shot(page, testInfo, '03-request-form');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main.getByTestId('size-request-pending')).toHaveText(
    'Your request for 24 GB is waiting for an admin.'
  );
  await shot(page, testInfo, '04-request-pending');

  // ── The admin's list on Settings shows it (the organization's list: scoped to this project) ──
  await page.goto(settingsUrl);
  const row = main.getByTestId('size-request-row').filter({ hasText: projectName });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('24 GB');
  await expect(row).toContainText('Monorepo with vendored toolchains');
  await shot(page, testInfo, '05-admin-pending');

  try {
    // ── Phone width: both pages hold their layout ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, '10-settings-mobile');
    await page.goto(projectUrl);
    await expect(limitText).toHaveCount(1);
    await expect(main.getByTestId('size-request-pending')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, '09-project-mobile');
  } finally {
    // Off the organization's list for everyone else.
    const listed = await page.request.get('/api/admin/sandbox-size-requests');
    const body: { requests: { id: string; projectId: string; status: string }[] } =
      await listed.json();
    for (const item of body.requests) {
      if (item.projectId !== projectId || item.status !== 'pending') continue;
      await page.request.post(`/api/admin/sandbox-size-requests/${item.id}`, {
        data: { decision: 'denied', note: 'e2e cleanup' },
      });
    }
  }
}
