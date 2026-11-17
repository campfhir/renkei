/**
 * Microsoft Fabric, end to end in a browser: the operator's page renders
 * on the real server; the registration is staged through the admin route
 * its form calls; the authorize route asks Microsoft for Fabric's own
 * scopes and nothing of Graph; the person connects for real from the
 * Fabric card, opens their workspaces, a lakehouse's tables, and a
 * notebook's definition — which Fabric hands over as a long-running
 * operation: the operation page shows it being prepared, then the cells
 * arrive over the page's event stream, without a reload. Once connected,
 * the menu carries a Fabric row and search leads to the page rather than
 * the card. A phone-width pass closes it.
 *
 * Where the rules went: what the browser page shows and sends is
 * app/(app)/fabric/fabric-browser.model.test.ts; when the operation page
 * stops listening, falls back to polling and how a notebook reads is
 * operation-view.model.test.ts; following an operation and reporting its
 * end once is packages/connector-fabric/src/operations.test.ts; the
 * notification when nobody watches is apps/worker's
 * health/fabric-operations.test.ts; the tools are
 * lib/mcp-tools/fabric/tools.test.ts.
 *
 * Fabric is the sandbox stub's stand-in (e2e/sandbox-stub.mjs,
 * handleFabric, reached through FABRIC_API_BASE_URL): one workspace, the
 * same for everyone, whose notebook definition takes a few seconds. The
 * connect flow is the in-memory app's fake OAuth. The Fabric registration
 * is organization-wide and only this spec writes it; it is switched on and
 * left on, as every registration is.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  addConnectors,
  connectThrough,
  fakeConsentRequest,
  registerConnector,
} from './support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DIRECTORY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('fabric: connect, browse a workspace, and watch a notebook definition arrive', async ({
  page,
  person: _person,
}, testInfo) => {
  // --- The operator's page renders; the registration is staged through its route. ---
  await page.goto('/admin/connectors/fabric');
  await expect(page.getByRole('heading', { name: 'Microsoft Fabric', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('Read, create and edit notebooks')).toBeVisible();
  await registerConnector(
    page.request,
    'fabric',
    {
      clientId: 'e2e-fabric-client',
      clientSecret: 'e2e-fabric-secret',
      directoryTenantId: DIRECTORY_ID,
    },
    ['directoryTenantId']
  );

  // --- Fabric's own scopes go to Microsoft, and no Graph scope with them. ---
  await addConnectors(page.request, ['fabric']);
  const authorize = await page.request.get('/api/fabric/authorize', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = fakeConsentRequest(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(
    `https://login.microsoftonline.com/${DIRECTORY_ID}/oauth2/v2.0/authorize`
  );
  const scopes = consent.searchParams.get('scope')?.split(' ') ?? [];
  expect(scopes).toContain('https://api.fabric.microsoft.com/Notebook.ReadWrite.All');
  expect(scopes).not.toContain('User.Read');

  // --- Connected from its card; the menu now carries the Fabric page. ---
  await connectThrough(page, '/api/fabric/authorize');
  const card = page.locator('[data-coach="card-fabric"]').filter({ visible: true });
  await expect(card.getByText('Connected as')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open Fabric' })).toHaveAttribute('href', '/fabric');
  await page.getByRole('link', { name: 'Fabric', exact: true }).filter({ visible: true }).click();
  await page.waitForURL(/\/fabric$/);

  // --- A workspace, its items, a lakehouse's tables. ---
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Sales Analytics' }).click();
  const items = main.getByRole('region', { name: 'Items in Sales Analytics' });
  await expect(items.getByText('Load orders')).toBeVisible();
  await expect(items.getByText('Nightly load')).toBeVisible();
  await items.getByRole('button', { name: 'Tables' }).click();
  const tables = items.getByRole('list', { name: 'Tables in Bronze' });
  await expect(tables.getByText('orders', { exact: true })).toBeVisible();
  await expect(tables.getByText('customers', { exact: true })).toBeVisible();
  await shot(page, testInfo, 'fabric-01-workspace');

  // --- The notebook's definition: prepared, then streamed in. ---
  const notebookRow = items.getByRole('listitem').filter({ hasText: 'Load orders' });
  await notebookRow.getByRole('button', { name: 'Get definition' }).click();
  await page.waitForURL(/\/fabric\/operations\/[0-9a-f-]{36}$/);
  const status = main.getByRole('status');
  await expect(status.getByText("Fabric is preparing the notebook's definition…")).toBeVisible();
  await expect(status.getByText(/you will be notified when it is ready/)).toBeVisible();
  await shot(page, testInfo, 'fabric-02-preparing');

  await expect(status.getByText("The notebook's definition is ready.")).toBeVisible({
    timeout: 30_000,
  });
  const cells = main.getByRole('list', { name: 'Cells' });
  await expect(cells.getByText('Cell 2 · code')).toBeVisible();
  await expect(
    cells.getByText('df = spark.read.table("bronze.orders")', { exact: false })
  ).toBeVisible();
  await expect(main.getByRole('tab', { name: 'notebook-content.ipynb' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await shot(page, testInfo, 'fabric-03-definition');

  // --- Search finds the page by a word only the connector knows; it lists the fetch as ready. ---
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await search.click();
  await search.fill('lakehouse');
  await page
    .getByRole('listbox', { name: 'Results' })
    .getByRole('option', { name: /Microsoft Fabric/ })
    .click();
  await page.waitForURL(/\/fabric$/);
  const recent = main.getByRole('region', { name: 'Definitions you fetched' });
  await expect(recent.getByRole('link', { name: /Load orders/ }).first()).toBeVisible();
  await expect(recent.getByText(/Ready ·/).first()).toBeVisible();

  // --- Phone width: nothing scrolls sideways. ---
  await page.setViewportSize(MOBILE_VIEWPORT);
  await main.getByRole('button', { name: 'Sales Analytics' }).click();
  await expect(items.getByText('Load orders')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'fabric-04-mobile');
});
