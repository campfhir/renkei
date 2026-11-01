/**
 * The org's model roster in a browser, on the in-memory data store: one
 * walk of the page end to end, and the form's fit at a phone's width.
 *
 * Where the rules went:
 *   - the form's behaviour — which fields the provider and API surface
 *     show, the Images/FLUX surfaces disabling "Organization default" and
 *     Test connection, the Responses API opt-in, the reasoning-effort hint
 *     per provider, typed token counts (200k, 1m, 4k, 8000) and what is
 *     refused, what makes a test or a model list stale, what Save, List
 *     and Test send (isDefault never for an image model), the row badges
 *     ("Not BAA-covered", "Retention unknown", "Image generation") and the
 *     first model defaulting to organization default — is
 *     app/(app)/admin/llm-models/model-forms.model.ts, tested in
 *     model-forms.model.test.ts;
 *   - what the server stores and refuses — settings round-tripping through
 *     POST/PUT and GET, an image model never stored as the default, the
 *     image surface refused on Anthropic, keys sealed and kept — is
 *     app/api/admin/llm-models/route.test.ts and [modelId]/route.test.ts.
 *
 * What stays is what only a browser shows. The first test is the worked
 * example of a spec on the memory store (AGENTS.md, "UI changes"):
 *   - each test signs in as a person of its own (`person`,
 *     e2e/fixtures.ts: signed in through the test sign-in route,
 *     enrolled through the real delegate) — here an operator;
 *   - llm_model_configs is ORGANIZATION-wide, and every project and spec
 *     shares one server: a test names its rows distinctively (`tagged`),
 *     scopes each assertion to its own row (`modelRow`), and removes its
 *     rows afterwards through the roster's own DELETE route. It can never
 *     assume the table is empty, so the empty state is the list route
 *     answered empty at the browser edge (`page.route`), the way a vendor
 *     call ("Test connection") is answered;
 *   - the save goes through the real route (no mock on save) into the
 *     server's store, sealed under its real TOKEN_ENCRYPTION_KEY; only the
 *     organization default, one slot every spec shares, is kept out of it;
 *   - "mobile" is a resized Chromium viewport, not a device descriptor.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// The roster is the console's: an operator's page.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** This test's own suffix: labels are unique org-wide, and every project saves its own. */
let tag = '';
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 4)}`;
});

// What the test saved goes again, through the roster's own delete route:
// the table is everybody's.
test.afterEach(async ({ page, person: _person }) => {
  const listed = await page.request.get('/api/admin/llm-models');
  const body: unknown = await listed.json();
  const models =
    typeof body === 'object' && body !== null && 'models' in body && Array.isArray(body.models)
      ? body.models
      : [];
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id : null;
    const label = typeof model?.label === 'string' ? model.label : '';
    if (id && label.endsWith(` ${tag}`)) {
      expect((await page.request.delete(`/api/admin/llm-models/${id}`)).ok()).toBe(true);
    }
  }
});

/** A label no other test uses. */
function tagged(label: string): string {
  return `${label} ${tag}`;
}

/** One saved model's card on the roster, found by its own Remove button. */
function modelRow(page: Page, label: string) {
  return page.locator('div.rounded-lg', {
    has: page.getByRole('button', { name: `Remove ${label}`, exact: true }),
  });
}

/**
 * Save the open form, and wait for the roster to reload: the form closes
 * as soon as the save answers, a moment before the list comes back, and
 * an Edit in between would reopen the row as it was.
 */
async function saveModel(page: Page): Promise<void> {
  const reloaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/llm-models') && response.request().method() === 'GET'
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await reloaded;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('admin: the model roster, testing, and saving', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Prod Claude');

  // The roster is everybody's, so "empty" is the list answered empty at
  // the browser edge; the real list is back before anything is saved.
  await page.route('**/api/admin/llm-models', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { models: [] } }) : route.fallback()
  );
  await page.goto('/admin/llm-models');
  await expect(page.getByRole('heading', { name: 'Agent models' })).toBeVisible();
  await expect(page.getByText('No models configured yet')).toBeVisible();
  await shot(page, testInfo, 'llm-models-01-empty');
  await page.unroute('**/api/admin/llm-models');

  await page.getByRole('button', { name: '+ Add a model' }).click();
  await page.getByLabel('Display name').fill(label);
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-ant-e2e-fake-key');
  await shot(page, testInfo, 'llm-models-02-draft-filled');

  // "Test connection": one real chat completion in production; here the
  // vendor's answer at the browser edge, so the request the form sends and
  // the success it draws are what's under test.
  let tested: unknown = null;
  await page.route('**/api/admin/**/llm-models/test', async (route) => {
    tested = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, model: 'claude-sonnet-5', reply: 'ok' } });
  });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('The model responded: “ok”')).toBeVisible();
  expect(tested).toMatchObject({
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-ant-e2e-fake-key',
  });
  await shot(page, testInfo, 'llm-models-04-tested-ok');

  // Actually save — the real POST route, the real store, the real
  // encrypt-at-rest.
  await page.getByRole('checkbox', { name: 'Organization default' }).check();
  // The organization default is one slot every spec shares (artifacts.spec.ts
  // keeps its stub there for summaries): the form must ask for it, but the
  // store is left with the default it had, and the roster read after the
  // save answers with this row as the default — what the badge draws from.
  const sent: { isDefault?: unknown } = {};
  await page.route('**/api/admin/llm-models', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body: unknown = request.postDataJSON();
      if (typeof body === 'object' && body !== null) Object.assign(sent, body);
      await route.continue({ postData: JSON.stringify({ ...sent, isDefault: false }) });
      return;
    }
    const response = await route.fetch();
    const roster: unknown = await response.json();
    const models: unknown[] =
      typeof roster === 'object' &&
      roster !== null &&
      'models' in roster &&
      Array.isArray(roster.models)
        ? roster.models
        : [];
    await route.fulfill({
      response,
      json: {
        ...(typeof roster === 'object' ? roster : {}),
        models: models.map((model) =>
          typeof model === 'object' && model !== null
            ? { ...model, isDefault: Reflect.get(model, 'label') === label }
            : model
        ),
      },
    });
  });
  await saveModel(page);
  expect(sent.isDefault).toBe(true);
  const row = modelRow(page, label);
  await expect(row).toBeVisible();
  await expect(row.getByText('key stored')).toBeVisible();
  await expect(row.getByText('Default', { exact: true })).toBeVisible();
  // Drawn from the stored row: nothing was said about data handling.
  await expect(row.getByText('Not BAA-covered')).toBeVisible();
  await shot(page, testInfo, 'llm-models-06-saved');
  await page.unroute('**/api/admin/llm-models');

  // Mobile: a resized Chromium viewport — the layout question here is
  // "does the form fit and stay usable", which a viewport size answers.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'llm-models-07-mobile-list');
  await row.getByRole('button', { name: 'Edit' }).click();
  // The edit form is a modal dialog over the roster, not a block at its foot.
  const editDialog = page.getByRole('dialog', { name: 'Edit model' });
  await expect(editDialog).toBeVisible();
  // Reopened from the stored row: the real save kept what was typed.
  await expect(editDialog.getByLabel('Model id')).toHaveValue('claude-sonnet-5');
  await shot(page, testInfo, 'llm-models-08-mobile-edit');
  await editDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editDialog).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('admin: the token fields fit a phone — typed as text, max output level with temperature', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/admin/llm-models');
  await page.getByRole('button', { name: '+ Add a model' }).click();
  const form = page.getByRole('dialog', { name: 'Add a model' });
  await expect(form).toBeVisible();

  // A phone's numeric keypad has no "k" or "m", so neither count asks for it.
  for (const name of ['Context window (tokens)', 'Max output tokens']) {
    const field = form.getByLabel(name);
    await expect(field).toHaveAttribute('type', 'text');
    await expect(field).not.toHaveAttribute('inputmode', 'numeric');
  }
  await form.getByLabel('Context window (tokens)').fill('1m');
  await expect(form.getByLabel('Context window (tokens)')).toHaveValue('1m');

  // The two inputs share a top edge even when the label wraps at phone width.
  const outputBox = await form.getByLabel('Max output tokens').boundingBox();
  const temperatureBox = await form.getByLabel('Temperature').boundingBox();
  expect(outputBox?.y).toBeCloseTo(temperatureBox?.y ?? NaN, 0);
  await shot(page, testInfo, 'llm-models-max-output-mobile');
});
