/**
 * The org's model roster, end to end in a browser, on the in-memory data
 * store: the empty state, adding a model, "List available models" and
 * "Test connection" (both mocked at the browser edge — no real provider
 * key in e2e), and the saved row.
 *
 * "Test connection" is worth its own coverage beyond the unit tests in
 * packages/agent-llm: it is the one place a person watches the exact wording
 * of a success or failure, and the one place a typo in the wiring between
 * the form and the route would go unnoticed by a type checker.
 *
 * Every save goes through the real route (no mock on save) into the
 * server's store, sealed under its real TOKEN_ENCRYPTION_KEY — the "tokens
 * can save" question this feature exists to answer.
 *
 * The worked example of a spec on the memory store (AGENTS.md, "UI
 * changes"):
 *   - each test signs in as a person of its own (`person`,
 *     e2e/fixtures.ts: signed in through the test sign-in route,
 *     enrolled through the real delegate) — here an operator;
 *   - llm_model_configs is ORGANIZATION-wide, and every project and spec
 *     shares one server: a test names its rows distinctively (`tagged`),
 *     scopes each assertion to its own row (`modelRow`), and removes its
 *     rows afterwards through the roster's own DELETE route. It can never
 *     assume the table is empty,
 *     so the empty state is the list route answered empty at the browser
 *     edge (`page.route`), the way a vendor call is answered;
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

/** Open the edit form of one's own model. */
async function editModel(page: Page, label: string): Promise<void> {
  await modelRow(page, label).getByRole('button', { name: 'Edit' }).click();
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

async function openNewModel(page: Page, label: string, provider?: string): Promise<void> {
  await page.goto('/admin/llm-models');
  await page.getByRole('button', { name: '+ Add a model' }).click();
  await page.getByLabel('Display name').fill(label);
  if (provider) await page.getByLabel('Provider').selectOption(provider);
}

test('admin: the model roster, listing, testing, and saving', async ({
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

  // "List available models": proves the key can reach the provider's
  // models endpoint. Mocked — no real Anthropic key in e2e.
  await page.route('**/api/admin/**/llm-models/available', async (route) => {
    await route.fulfill({
      json: {
        models: [
          { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
          { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
        ],
      },
    });
  });
  await page.getByRole('button', { name: 'List available models' }).click();
  await expect(page.getByRole('button', { name: 'claude-sonnet-5' })).toBeVisible();
  await shot(page, testInfo, 'llm-models-03-listed');

  // "Test connection": one real chat completion in production; here, a
  // mocked success so the exact success copy is what's under test.
  await page.route('**/api/admin/**/llm-models/test', async (route) => {
    await route.fulfill({ json: { ok: true, model: 'claude-sonnet-5', reply: 'ok' } });
  });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('The model responded: “ok”')).toBeVisible();
  await shot(page, testInfo, 'llm-models-04-tested-ok');

  // Editing the model id invalidates the stale test result (a real
  // completion answers for the settings it was sent with, not new ones).
  await page.getByLabel('Model id').fill('claude-sonnet-5-typo');
  await expect(page.getByText('The model responded: “ok”')).toHaveCount(0);

  // The failure path: a bad model id / deployment name, worded distinctly
  // from an auth failure so an operator knows what to fix.
  await page.unroute('**/api/admin/**/llm-models/test');
  await page.route('**/api/admin/**/llm-models/test', async (route) => {
    await route.fulfill({
      status: 400,
      json: {
        error: 'The provider did not understand the request — check the model id and base URL.',
      },
    });
  });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    page.getByText('The provider did not understand the request — check the model id and base URL.')
  ).toBeVisible();
  await shot(page, testInfo, 'llm-models-05-tested-error');

  // Fix the model id and actually save — the real POST route, the real
  // store, the real encrypt-at-rest.
  await page.getByLabel('Model id').fill('claude-sonnet-5');
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
  // Nothing was said about data handling, so the roster warns: a row an
  // operator has not confirmed a BAA for must not look like one they have.
  await expect(row.getByText('Not BAA-covered')).toBeVisible();
  await shot(page, testInfo, 'llm-models-06-saved');
  await page.unroute('**/api/admin/llm-models');

  // Mobile: a resized Chromium viewport — the layout question here is
  // "does the form fit and stay usable", which a viewport size answers.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'llm-models-07-mobile-list');
  await editModel(page, label);
  // The edit form is a modal dialog over the roster, not a block at its foot.
  const editDialog = page.getByRole('dialog', { name: 'Edit model' });
  await expect(editDialog).toBeVisible();
  await shot(page, testInfo, 'llm-models-08-mobile-edit');
  await editDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editDialog).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('admin: reasoning effort is free text — no fixed value list — and round-trips through save', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Astra Reasoning');
  await openNewModel(page, label, 'openai');
  await page.getByLabel('Model id').fill('gpt-6-astra-1');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-e2e-fake-key');

  // Which reasoning_effort values a model accepts is entirely the
  // provider's call and varies by model, so the field takes any value.
  await page.getByLabel('Reasoning effort').fill('xhigh');
  // The context window the chat's usage meter measures against.
  await page.getByLabel('Context window (tokens)').fill('400000');
  await shot(page, testInfo, 'llm-models-reasoning-effort-freetext');

  await saveModel(page);
  await expect(modelRow(page, label)).toBeVisible();

  // Round-trips through the real save route and store.
  await editModel(page, label);
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('xhigh');
  await expect(page.getByLabel('Context window (tokens)')).toHaveValue('400000');
});

test('admin: reasoning effort is offered for a Claude row too, with its own hint, and round-trips', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Sonnet quick');
  await page.goto('/admin/llm-models');
  await page.getByRole('button', { name: '+ Add a model' }).click();
  // Anthropic is the default provider: the field is there without switching.
  await expect(page.getByLabel('Provider')).toHaveValue('anthropic');
  const reasoningEffort = page.getByLabel('Reasoning effort');
  await expect(reasoningEffort).toBeVisible();
  // The Claude hint, not the GPT one.
  await expect(page.getByText('output_config.effort')).toBeVisible();
  await expect(page.getByText('GPT-5 family')).toHaveCount(0);

  await page.getByLabel('Display name').fill(label);
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-ant-e2e-fake-key');
  await reasoningEffort.fill('low');
  await shot(page, testInfo, 'llm-models-reasoning-effort-claude');

  await saveModel(page);
  await expect(modelRow(page, label)).toBeVisible();

  await editModel(page, label);
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('low');

  // Phone width: the field and its hint still fit the form.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByLabel('Reasoning effort')).toBeVisible();
  await shot(page, testInfo, 'llm-models-reasoning-effort-claude-mobile');
});

test('admin: API surface can opt an OpenAI-compatible model into the Responses API', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Astra Responses');
  await page.goto('/admin/llm-models');

  // Anthropic (the default provider) never shows the toggle.
  await page.getByRole('button', { name: '+ Add a model' }).click();
  await expect(page.getByLabel('API surface')).toHaveCount(0);

  await page.getByLabel('Display name').fill(label);
  await page.getByLabel('Provider').selectOption('openai');
  await expect(page.getByLabel('API surface')).toBeVisible();
  await page.getByLabel('Model id').fill('gpt-6-astra-1');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-e2e-fake-key');
  await page.getByLabel('API surface').selectOption('responses');
  await shot(page, testInfo, 'llm-models-api-surface-responses-selected');

  await saveModel(page);
  await expect(modelRow(page, label)).toBeVisible();

  await editModel(page, label);
  await expect(page.getByLabel('API surface')).toHaveValue('responses');
});

test('admin: the Images API surface makes an image generation model — never the default, no chat test', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Painter');
  await page.goto('/admin/llm-models');
  await page.getByRole('button', { name: '+ Add a model' }).click();

  // The Images API is OpenAI's: Anthropic has no such surface to pick.
  await expect(page.getByLabel('API surface')).toHaveCount(0);

  await page.getByLabel('Display name').fill(label);
  await page.getByLabel('Provider').selectOption('openai');
  await page.getByLabel('Model id').fill('gpt-image-1');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-e2e-fake-key');

  // The Images surface takes the model out of the chat-only choices.
  const defaultBox = page.getByRole('checkbox', { name: 'Organization default' });
  await defaultBox.check();
  await page.getByLabel('API surface').selectOption('images');
  await expect(page.getByTestId('image-surface-hint')).toBeVisible();
  await expect(defaultBox).toBeDisabled();
  await expect(defaultBox).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  await expect(page.getByText('cannot be tested here')).toBeVisible();
  await expect(page.getByText('Some reasoning-model deployments')).toHaveCount(0);
  await shot(page, testInfo, 'llm-models-image-model-form');

  // FLUX is an image surface too, with its own endpoint guidance.
  await page.getByLabel('API surface').selectOption('flux');
  await expect(page.getByTestId('image-surface-hint')).toContainText('providers/blackforestlabs');
  await expect(defaultBox).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  await page.getByLabel('API surface').selectOption('images');
  await expect(page.getByTestId('image-surface-hint')).toContainText('gpt-image');

  // Back to a chat surface restores the chat test and the default box.
  await page.getByLabel('API surface').selectOption('');
  await expect(defaultBox).toBeEnabled();
  await page.getByLabel('API surface').selectOption('images');

  await saveModel(page);
  const row = modelRow(page, label);
  await expect(row).toBeVisible();
  // The row says what it is, and it is not the default.
  await expect(row.getByText('Image generation', { exact: true })).toBeVisible();
  await expect(row.getByText('Default', { exact: true })).toHaveCount(0);

  await editModel(page, label);
  await expect(page.getByLabel('API surface')).toHaveValue('images');

  // Switching the provider to Anthropic drops the surface: it has no Images API.
  await page.getByLabel('Provider').selectOption('anthropic');
  await expect(page.getByLabel('API surface')).toHaveCount(0);
  await page.getByLabel('Provider').selectOption('openai');
  await expect(page.getByLabel('API surface')).toHaveValue('');
  await page.getByLabel('API surface').selectOption('images');

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByLabel('API surface')).toBeVisible();
  await shot(page, testInfo, 'llm-models-image-model-form-mobile');
});

test('admin: data handling — residency, retention and the BAA flag round-trip and clear the warning', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Covered Claude');
  await openNewModel(page, label);
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-ant-e2e-fake-key');
  // A BAA without a retention term is still a warning.
  await page.getByRole('checkbox', { name: /Business Associate Agreement/ }).check();
  await saveModel(page);
  const row = modelRow(page, label);
  await expect(row).toBeVisible();
  await expect(row.getByText('Retention unknown')).toBeVisible();
  await shot(page, testInfo, 'llm-models-data-handling-01-retention-unknown');

  await editModel(page, label);
  await expect(page.getByRole('checkbox', { name: /Business Associate Agreement/ })).toBeChecked();
  await page.getByLabel('Data residency').fill('Azure East US, DataZone');
  await page.getByLabel('Data retention').selectOption('none');
  await page.getByLabel('Notes').fill('BAA signed 2026-01; zero retention confirmed.');
  await shot(page, testInfo, 'llm-models-data-handling-02-filled');
  await saveModel(page);
  await expect(row).toBeVisible();
  await expect(row.getByText('Retention unknown')).toHaveCount(0);
  await expect(row.getByText('Not BAA-covered')).toHaveCount(0);
  await shot(page, testInfo, 'llm-models-data-handling-03-covered');

  // Through the real save route and the stored settings, back into the form.
  await editModel(page, label);
  await expect(page.getByLabel('Data residency')).toHaveValue('Azure East US, DataZone');
  await expect(page.getByLabel('Data retention')).toHaveValue('none');
  await expect(page.getByLabel('Notes')).toHaveValue(
    'BAA signed 2026-01; zero retention confirmed.'
  );

  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'llm-models-data-handling-04-mobile-edit');
});

test('admin: context window takes a typed count — 200k, 1m — and refuses what is not one', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Long Context');
  await openNewModel(page, label);
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-ant-e2e-fake-key');

  // Not a number field: the suffixes people actually write are accepted.
  const contextWindow = page.getByLabel('Context window (tokens)');
  await expect(contextWindow).toHaveAttribute('placeholder', '200k');
  await contextWindow.fill('lots');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Context window must be a token count, such as 200k or 1m.')
  ).toBeVisible();
  await shot(page, testInfo, 'llm-models-context-window-01-refused');

  await contextWindow.fill('1m');
  await saveModel(page);
  await expect(modelRow(page, label)).toBeVisible();

  // Stored as the whole count, shown back as a plain number to edit.
  await editModel(page, label);
  await expect(page.getByLabel('Context window (tokens)')).toHaveValue('1000000');
  await page.getByLabel('Context window (tokens)').fill('200k');
  await saveModel(page);
  await expect(page.getByLabel('Context window (tokens)')).toHaveCount(0);
  await editModel(page, label);
  await expect(page.getByLabel('Context window (tokens)')).toHaveValue('200000');
  await shot(page, testInfo, 'llm-models-context-window-02-saved');

  // A phone's numeric keypad has no "k" or "m", so the field must not ask for it.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByLabel('Context window (tokens)')).not.toHaveAttribute(
    'inputmode',
    'numeric'
  );
  await page.getByLabel('Context window (tokens)').fill('1m');
  await expect(page.getByLabel('Context window (tokens)')).toHaveValue('1m');
  await shot(page, testInfo, 'llm-models-context-window-03-mobile');
});

test('admin: max output tokens takes 4k and 8000, sits level with temperature on a phone', async ({
  page,
  person: _person,
}, testInfo) => {
  const label = tagged('Verbose');
  await openNewModel(page, label);
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByRole('textbox', { name: 'API key' }).fill('sk-ant-e2e-fake-key');

  // A typed count like the context window's, not a number field.
  const maxOutput = page.getByLabel('Max output tokens');
  await expect(maxOutput).toHaveAttribute('placeholder', '4k');
  await maxOutput.fill('lots');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Max output tokens must be a token count, such as 4k or 8000.')
  ).toBeVisible();

  await maxOutput.fill('4k');
  await saveModel(page);
  await expect(modelRow(page, label)).toBeVisible();

  await editModel(page, label);
  await expect(page.getByLabel('Max output tokens')).toHaveValue('4000');
  await page.getByLabel('Max output tokens').fill('8000');
  await saveModel(page);
  await expect(page.getByLabel('Max output tokens')).toHaveCount(0);
  await editModel(page, label);
  await expect(page.getByLabel('Max output tokens')).toHaveValue('8000');

  // The two inputs share a top edge even when the label wraps at phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  const outputBox = await page.getByLabel('Max output tokens').boundingBox();
  const temperatureBox = await page.getByLabel('Temperature').boundingBox();
  expect(outputBox?.y).toBeCloseTo(temperatureBox?.y ?? NaN, 0);
  await shot(page, testInfo, 'llm-models-max-output-mobile');
});
