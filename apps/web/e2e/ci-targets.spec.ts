/**
 * Targets, end to end in a browser: an operator connects the Bitbucket
 * workspace (through the Bitbucket connector's OAuth consumer, by client
 * credentials: nothing pasted) and the GitHub organization (a
 * GitHub App's ID and private key, generated here), the runners each host
 * reports appear in no target, a target made by hand takes the runners
 * carrying its labels on both hosts, another is made from a loose runner's
 * labels in one click, a mistake in the labels is called out, and the page
 * fits a phone.
 *
 * The hosts are the sandbox stub's (e2e/sandbox-stub.mjs, `e2e-ci-*`): its
 * GitHub answers the App's installation and token exchange and the
 * organization's runners; its Bitbucket the client credentials grant for
 * the code hosts' test consumer (support/code-host.ts) and the runners
 * endpoint, which takes only the token that grant gave. Where the rules went: the cards, forms and suggestions —
 * targets-page.model.test.ts; matching runners to targets —
 * packages/ci-blocks targets.test.ts; reading each host, the JWT and the
 * refusals — lib/ci/runners.test.ts; secrets kept write-only —
 * lib/ci/targets.test.ts.
 *
 * The service accounts and targets are organization-wide: only this spec
 * writes the accounts, its targets carry this run's tag, and both go again
 * through the routes at the end. Runs in desktop-light only.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { prepareCodeHost } from './support/code-host';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const WORKSPACE = 'e2e-ci-acme';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/** This run's targets, and any a failed earlier run left with the same labels, go. */
async function removeTargets(
  request: APIRequestContext,
  keep: (name: string) => boolean = () => false
) {
  const page = await request.get('/api/admin/ci-targets');
  if (!page.ok()) return;
  const body: unknown = await page.json();
  const targets =
    typeof body === 'object' && body !== null && 'targets' in body && Array.isArray(body.targets)
      ? body.targets
      : [];
  for (const target of targets) {
    if (
      typeof target?.name === 'string' &&
      /^(workers|dmz)-/.test(target.name) &&
      !keep(target.name)
    ) {
      await request.delete(`/api/admin/ci-targets/${String(target.id)}`);
    }
  }
}

test('targets: connect both hosts, make targets from runners @smoke', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The service accounts are organization-wide: one writer.'
  );
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  await removeTargets(page.request);
  // The Bitbucket connector's OAuth consumer, which the workspace is read with.
  await prepareCodeHost(request);

  try {
    await page.goto('/admin');
    await page
      .getByRole('navigation', { name: 'Organization areas' })
      .getByRole('link', { name: 'Targets' })
      .click();
    await expect(page.getByRole('heading', { name: 'Targets', level: 1 })).toBeVisible();

    // --- Bitbucket, with the connector's OAuth consumer: nothing to paste. ---
    await page.request.delete('/api/admin/ci-accounts/bitbucket');
    await page.reload();
    const bitbucket = page.getByTestId('account-bitbucket');
    await bitbucket.getByRole('button', { name: 'Connect Bitbucket' }).click();
    await expect(bitbucket.getByRole('combobox', { name: 'Signs in with' })).toHaveValue(
      'connector'
    );
    await expect(bitbucket.getByRole('textbox', { name: /token|secret/i })).toHaveCount(0);
    await bitbucket.getByRole('textbox', { name: 'Workspace', exact: true }).fill(WORKSPACE);
    await bitbucket.getByRole('button', { name: 'Save and read runners' }).click();
    await expect(page.getByRole('status')).toHaveText('Bitbucket account saved.');
    await expect(bitbucket).toContainText(
      'The Bitbucket connector’s OAuth consumer, by client credentials.'
    );
    await expect(bitbucket).toContainText('Connected');
    await expect(bitbucket).toContainText('2 runners · read just now');

    // --- GitHub, with the App's ID and private key. ---
    const github = page.getByTestId('account-github');
    await github.getByRole('button', { name: /^(Connect GitHub|Change)$/ }).click();
    await github.getByRole('textbox', { name: 'Organization', exact: true }).fill(WORKSPACE);
    await github.getByRole('textbox', { name: 'App ID', exact: true }).fill('12345');
    await github.getByRole('textbox', { name: /^Private key/ }).fill(pem);
    await github.getByRole('button', { name: 'Save and read runners' }).click();
    await expect(page.getByRole('status')).toHaveText('GitHub account saved.');
    await expect(github).toContainText('2 runners · read just now');

    // --- Every runner is in no target yet. ---
    const loose = page.getByRole('region', { name: 'Runners in no target' });
    for (const name of ['workers-01', 'dmz-edge-01', 'workers-02', 'build-mac-01']) {
      await expect(loose).toContainText(name);
    }

    // --- A target by hand, a label mistake called out first. ---
    await page.getByRole('button', { name: 'New target' }).click();
    const form = page.getByTestId('target-form');
    await form.getByRole('textbox', { name: /^Name/ }).fill(`workers-${tag}`);
    await form
      .getByRole('textbox', { name: /^GitHub runner labels/ })
      .fill('linux, onprem-workers');
    await expect(form.getByRole('alert')).toContainText(
      'GitHub labels must include self-hosted, or the job goes to a hosted runner.'
    );
    await expect(form.getByRole('button', { name: 'Save target' })).toBeDisabled();
    await form
      .getByRole('textbox', { name: /^GitHub runner labels/ })
      .fill('self-hosted, onprem-workers');
    await form
      .getByRole('textbox', { name: /^Bitbucket runner labels/ })
      .fill('self.hosted, onprem-workers');
    await form.getByRole('button', { name: 'Save target' }).click();
    await expect(page.getByRole('status')).toHaveText(`Target workers-${tag} saved.`);
    const workers = page.getByTestId('target-card').filter({ hasText: `workers-${tag}` });
    await expect(workers).toContainText('All 2 online');
    await expect(workers).toContainText('workers-01 online');
    await expect(workers).toContainText('workers-02 busy');
    await expect(loose).not.toContainText('workers-01');

    // --- Another, from a loose runner's labels. ---
    await loose
      .getByRole('listitem')
      .filter({ hasText: 'dmz-edge-01' })
      .getByRole('button', { name: 'Make a target from these labels' })
      .click();
    await expect(form.getByRole('textbox', { name: /^Bitbucket runner labels/ })).toHaveValue(
      'self.hosted, linux, dmz'
    );
    await form.getByRole('textbox', { name: /^Name/ }).fill(`dmz-${tag}`);
    await form.getByRole('button', { name: 'Save target' }).click();
    await expect(page.getByTestId('target-card').filter({ hasText: `dmz-${tag}` })).toContainText(
      '0 of 1 online'
    );
    await shot(page, testInfo, 'ci-targets-01-desktop');

    // --- At a phone's width: no sideways scroll. ---
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(workers).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'ci-targets-02-phone');
  } finally {
    await removeTargets(page.request);
    await page.request.delete('/api/admin/ci-accounts/bitbucket');
    await page.request.delete('/api/admin/ci-accounts/github');
  }
});
