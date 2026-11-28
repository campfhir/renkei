/**
 * Building blocks, end to end in a browser: an operator finds the page
 * from the Organization page, starts a block by describing it (the
 * organization's model answering at the browser edge — the default model
 * is shared org state, and what the model says is all this needs), checks
 * the preview for both hosts, saves the draft, publishes it, sees it in the
 * list, and the editor fits a phone.
 *
 * Where the rules went: what the form makes, what is wrong as you type,
 * when Save and Publish are offered, the preview — block-editor.model.test.ts;
 * the list's rows and filters — blocks-list.model.test.ts; drafts,
 * versions, refusals — lib/ci/blocks.test.ts; the renderers —
 * packages/ci-blocks; the AI's corrective round — lib/ci/draft-block.test.ts.
 *
 * Blocks are organization-wide: this run's block carries a key and name of
 * its own, assertions are scoped to it, and it is deleted through the
 * route at the end. Runs in desktop-light only, with the phone width as a
 * resized viewport.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('building blocks: draft with AI, preview both hosts, save, publish @smoke', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const key = `deploy-systemd-${tag}`.toLowerCase();
  const name = `Deploy with systemd ${tag}`;
  let blockId = '';

  try {
    // --- From the Organization page to the catalogue. ---
    await page.goto('/admin');
    await page
      .getByRole('navigation', { name: 'Organization areas' })
      .getByRole('link', { name: 'Building blocks' })
      .click();
    await expect(page.getByRole('heading', { name: 'Building blocks', level: 1 })).toBeVisible();

    // --- A new block, drafted from a description. ---
    await page.route('**/api/admin/ci-blocks/draft', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        description:
          'Deploy a Go service to our on-prem workers with systemd and check its health route.',
      });
      await route.fulfill({
        json: {
          key,
          name,
          description: 'Restart the unit and check its health route.',
          definition: {
            kind: 'deploy',
            runsOn: { type: 'target' },
            inputs: [{ name: 'service_name', type: 'text', description: 'The systemd unit' }],
            variables: [{ name: 'DEPLOY_TOKEN', secured: true }],
            consumes: ['dist'],
            produces: [],
            caches: [],
            commands: 'sudo systemctl restart ${input.service_name}',
          },
        },
      });
    });
    await page.getByRole('main').getByRole('link', { name: 'Draft a block with AI' }).click();
    await page
      .getByLabel('Describe the block you want')
      .fill('Deploy a Go service to our on-prem workers with systemd and check its health route.');
    await page.getByRole('button', { name: 'Draft the block' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Drafted. Check every field before saving: nothing is saved until you do.'
    );
    await expect(page.getByLabel('Key')).toHaveValue(key);

    // --- The preview, for each host. ---
    const preview = page.getByTestId('block-preview');
    await expect(preview).toContainText('runs-on:');
    await expect(preview).toContainText('self.hosted');
    await expect(preview).toContainText('sudo systemctl restart <service_name>');
    await page.getByRole('button', { name: 'GitHub Actions' }).click();
    await expect(preview).toContainText('DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}');
    await expect(preview).toContainText('actions/download-artifact@v4');
    await shot(page, testInfo, 'ci-blocks-01-drafted-github');

    // --- A half-finished change is called out, and Publish waits for it. ---
    const commands = page.getByLabel('Commands', { exact: true });
    await commands.fill('sudo systemctl restart ${input.unit}');
    await expect(page.getByTestId('block-problems')).toContainText(
      'The commands use ${input.unit}, but the block has no input “unit”.'
    );
    await expect(page.getByRole('button', { name: 'Publish v1' })).toBeDisabled();
    await commands.fill('sudo systemctl restart ${input.service_name}');

    // --- Saved as a draft, then published. ---
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/ci-blocks') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Save draft' }).click();
    const body: unknown = await (await created).json();
    blockId = typeof body === 'object' && body !== null && 'id' in body ? String(body.id) : '';
    await expect(page.getByTestId('block-status')).toHaveText('Draft — not published yet');
    await expect(page).toHaveURL(new RegExp(`/admin/ci-blocks/${blockId}$`));
    await page.getByRole('button', { name: 'Publish v1' }).click();
    await expect(page.getByTestId('block-status')).toHaveText('v1 published');
    await expect(page.getByRole('region', { name: 'Versions' })).toContainText('v1');
    await shot(page, testInfo, 'ci-blocks-02-published');

    // --- In the list, as a deploy block on a target, at v1. ---
    await page.getByRole('link', { name: '← Building blocks' }).click();
    await page.getByLabel('Filter blocks').fill(tag);
    const row = page.getByTestId('ci-blocks').getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('Deploy');
    await expect(row).toContainText('A target a pipeline picks');
    await expect(row).toContainText('DEPLOY_TOKEN (secured)');
    await expect(row).toContainText('v1');
    await shot(page, testInfo, 'ci-blocks-03-list');

    // --- The editor at a phone's width: no sideways scroll. ---
    await page.setViewportSize({ width: 390, height: 844 });
    await row.getByRole('link', { name }).click();
    await expect(page.getByTestId('block-status')).toHaveText('v1 published');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'ci-blocks-04-phone');
  } finally {
    if (blockId) await page.request.delete(`/api/admin/ci-blocks/${blockId}`);
  }
});

test('building blocks: a hosted block asks for Docker and leaves a variable optional', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const key = `build-image-${tag}`.toLowerCase();
  let blockId = '';

  try {
    await page.goto('/admin/ci-blocks/new');
    const main = page.getByRole('main');
    await main.getByLabel('Key').fill(key);
    await main.getByLabel('Name', { exact: true }).fill(`Build the image ${tag}`);
    await main.getByRole('textbox', { name: 'Container image' }).fill('docker:27-cli');
    await main.getByLabel('Commands', { exact: true }).fill('docker build .');

    // --- Docker, with the memory its build needs: the step and the file's definitions show it. ---
    await main.getByLabel('Needs Docker: it builds or runs containers').check();
    await main.getByLabel('Memory for Docker (MB)').fill('3072');
    const preview = page.getByTestId('block-preview');
    await expect(preview).toContainText('services:');
    await expect(preview).toContainText('# definitions.services in the pipeline file gains:');
    await expect(preview).toContainText('memory: 3072');
    await page.getByRole('button', { name: 'GitHub Actions' }).click();
    await expect(preview).toContainText('/var/run/docker.sock:/var/run/docker.sock');
    await shot(page, testInfo, 'ci-blocks-05-docker-github');

    // --- A variable it can do without. ---
    await main.getByRole('button', { name: '+ Add variable' }).click();
    await main.getByLabel('Variable 1 name').fill('BASE_PATH');
    await main.getByLabel('Variable 1 is optional').check();
    await main.getByRole('button', { name: '+ Add cache' }).click();
    await main.getByLabel('Cache 1 name').fill('pnpm');
    await main.getByLabel('Cache 1 directory').fill('~/.local/share/pnpm/store');
    await main.getByLabel('Cache 1 key files').fill('**/pnpm-lock.yaml');
    await main.getByLabel('Variable 1 description').fill('The prefix it is served under');
    await shot(page, testInfo, 'ci-blocks-06-optional-variable');

    // --- Save sends both, and they are there when the block is opened again. ---
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/ci-blocks') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Save draft' }).click();
    const response = await created;
    expect(response.request().postDataJSON().definition).toMatchObject({
      runsOn: { type: 'hosted', image: 'docker:27-cli', docker: { memory: 3072 } },
      variables: [{ name: 'BASE_PATH', secured: false, optional: true }],
    });
    const body: unknown = await response.json();
    blockId = typeof body === 'object' && body !== null && 'id' in body ? String(body.id) : '';
    await expect(page).toHaveURL(new RegExp(`/admin/ci-blocks/${blockId}$`));
    await page.reload();
    await expect(main.getByLabel('Needs Docker: it builds or runs containers')).toBeChecked();
    await expect(main.getByLabel('Memory for Docker (MB)')).toHaveValue('3072');
    await expect(main.getByLabel('Variable 1 is optional')).toBeChecked();
  } finally {
    if (blockId) await page.request.delete(`/api/admin/ci-blocks/${blockId}`);
  }
});
