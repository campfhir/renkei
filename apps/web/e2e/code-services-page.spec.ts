/**
 * A code project's Services from the person's side, in a browser: the
 * card on the project page (none yet, how many images are allowed)
 * opening the project's Services page, which renders the allowed images
 * on the real server; one press through — a Postgres started from the
 * form with its container variables and an export, the request reaching
 * the worker, the service listed running with its address and the
 * variables it sets; its lines in the combined tail, a later line
 * arriving while Follow is on; the card reflecting it; the page at phone
 * width; and, stopped through the route the page calls, the empty states
 * drawn. The sandbox worker is the stub in sandbox-stub.mjs (no engine: a
 * start reads running at a made-up address at once), which seeds the same
 * allowed images migration 121 does. The project is the test's own
 * person's, connected to Bitbucket and made through the Code routes
 * (e2e/support/code-host.ts), so no two tests share a service.
 *
 * Where its rules went: what the form opens with and sends, when Start can
 * be pressed, a refusal keeping the form, what Stop asks, the variables a
 * service sets, the tail's filter, Clear and pause, what it keeps and what
 * it says when empty — app/(app)/code/_components/services-page.model.test.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

interface Ids {
  projectId: string;
  name: string;
  repo: string;
}

async function stage(page: Page, testInfo: TestInfo): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const name = `Services demo (${tag})`;
  const repo = `acme/services-demo-${tag}`;
  const projectId = await createCodeProject(page.request, {
    name,
    description: 'Where a database runs beside the checkout.',
    repository: repo,
    branch: 'main',
  });
  return { projectId, name, repo };
}

/** Nothing scrolls sideways — the document, and the frame's own scroll container inside it. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const frame = document.querySelector('main .overflow-y-auto');
    return Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      frame ? frame.scrollWidth - frame.clientWidth : 0
    );
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('Code project services', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    await prepareCodeHost(request);
    await connectBitbucket(page);
    ids = await stage(page, testInfo);
  });

  test('card, page, a service started, its tail, phone width, stopped', async ({
    page,
  }, testInfo) => {
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const main = page.getByRole('main');
    const pagePath = `/code/${ids.projectId}/services`;

    // ── The project page: a card in the rail after the chats, before the environment ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const card = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Services' }),
    });
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Services')).toBeGreaterThan(at('Chats in this project'));
    expect(at('Environment')).toBeGreaterThan(at('Services'));
    await expect(card.getByText(/^None yet · \d+ allowed images/)).toBeVisible();
    await expect(card.getByText('None running')).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-services-card.png');

    // ── Into the page: nothing running, the allowed images listed ──
    await card.getByRole('link', { name: /Running services & logs/ }).click();
    await expect(page).toHaveURL(new RegExp(`${pagePath}$`));
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByText(ids.repo)).toBeVisible();
    const running = main.getByRole('region', { name: 'Running' });
    await expect(running.getByText(/^No services\./)).toBeVisible();
    const allowed = main.getByRole('region', { name: 'Allowed images' });
    await expect(allowed.getByText('docker.io/library/postgres', { exact: true })).toBeVisible();
    await expect(
      allowed.getByRole('link', { name: 'Organization → Code services' })
    ).toHaveAttribute('href', `/admin/code-services`);
    await expectNoHorizontalOverflow(page);
    await shot('code-services-page-empty.png');

    // ── Start a Postgres from the form: the container's variables and an
    //    export as text; it lists running with its address and what it sets ──
    await running.getByRole('button', { name: 'Start a service' }).click();
    const form = running.getByRole('form', { name: 'Start a service' });
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('db');
    await form.getByLabel('Image', { exact: true }).fill('postgres:16');
    await form.getByLabel(/^Container variables/).fill('POSTGRES_PASSWORD=test\nPOSTGRES_DB=app');
    await form
      .getByLabel(/^Exports/)
      .fill('DATABASE_URL=postgres://postgres:test@{host}:{port}/app');
    await shot('code-services-start-form.png');
    await form.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(running.getByRole('status')).toContainText('Started db');
    await expect(form).toHaveCount(0);
    const services = running.getByRole('list', { name: 'Services' });
    const dbRow = services.getByRole('listitem').filter({ hasText: 'db' });
    await expect(dbRow).toHaveCount(1);
    await expect(dbRow.getByText('Running')).toBeVisible();
    await expect(dbRow.getByText('docker.io/library/postgres:16')).toBeVisible();
    await expect(dbRow.getByText(/At 172\.20\.0\.\d+ on port 5432/)).toBeVisible();
    await expect(dbRow.getByText(/SERVICE_DB_HOST, SERVICE_DB_PORT, DATABASE_URL/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toContainText(
      '1 running'
    );
    await expectNoHorizontalOverflow(page);
    await shot('code-services-running.png');

    // ── The combined tail: the service's lines, named and stamped, and
    //    while Follow is on a line written later arrives on its own ──
    const logsCard = main.getByRole('region', { name: 'Logs' });
    const tail = logsCard.getByLabel('Combined logs');
    await expect(logsCard.getByLabel('Follow')).toBeChecked();
    await expect(tail).toContainText('db');
    await expect(tail).toContainText('database system is ready to accept connections');
    await expect(tail).toContainText('checkpoint 1', { timeout: 15_000 });
    await shot('code-services-logs.png');

    // ── Back on the project page, the card reflects it ──
    await main.getByRole('link', { name: ids.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible();
    await expect(card.getByText('1 running')).toBeVisible();
    await expect(card.getByText(/^db · \d+ allowed images/)).toBeVisible();

    // ── Phone width: the page again, the service still a card ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath);
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toBeVisible();
    await expect(dbRow.getByText('Running')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-services-mobile.png');

    // ── Stopped through the route the page calls, the empty states are drawn ──
    const stopped = await page.request.delete(`/api/code/projects/${ids.projectId}/services/db`);
    expect(stopped.ok(), await stopped.text()).toBe(true);
    await page.reload();
    await expect(running.getByText(/^No services\./)).toBeVisible();
    await expect(tail).toContainText('(no services)');
    await expect(page.getByRole('heading', { level: 1, name: /^Services/ })).toContainText(
      'None running'
    );
  });
});
