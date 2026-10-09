/**
 * The org's model roster, end to end in a browser: the empty state, adding
 * a model, "List available models" and "Test connection" (both mocked at
 * the browser edge — no real provider key in e2e), and the saved row.
 *
 * "Test connection" is worth its own coverage beyond the unit tests in
 * packages/agent-llm: it is the one place a person watches the exact wording
 * of a success or failure, and the one place a typo in the wiring between
 * the form and the route would go unnoticed by a type checker.
 *
 * This spec creates a real row through the real save route against the real
 * dev database (no mock on save) — the "tokens can save" question this
 * feature exists to answer, exercised through the browser rather than just
 * the route's unit tests.
 *
 * Each Playwright project (desktop-light, desktop-dark, …) gets its own
 * tenant, derived deterministically from the project name: the empty-state
 * screenshot needs the org to genuinely have zero models, and projects run
 * concurrently against the same dev Postgres, so sharing e2e/seed.ts's
 * tenant here (the way most specs do) would flake on which project's insert
 * lands first.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note). "Mobile" here means a resized Chromium
 * viewport, not the `mobile` project's iPhone device descriptor: a device
 * descriptor pulls in WebKit and a touch/UA profile this spec doesn't need
 * for a form layout check. See AGENTS.md's "UI changes" section — the
 * convention this spec exists to demonstrate.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** A deterministic (stable across reruns), valid-looking v4 UUID from a seed string. */
function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** This project's own tenant/session/slug — isolated from every other project and spec. */
function fixtureFor(projectName: string): {
  sessionId: string;
  slug: string;
  subject: string;
} {
  return {
    sessionId: uuidFrom(`llm-models-e2e-session:${projectName}`),
    slug: `e2e-llm-models-${projectName}`,
    subject: `e2e-llm-models-${projectName}@example.com`,
  };
}

async function seedTenant(fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Delete-then-insert, same idempotent shape as e2e/seed.ts, scoped to
    // just this project's own tenant.
    await client.query('DELETE FROM llm_model_configs');
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at)\n       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name)\n       VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Tester']
    );
    // No coach marks tour stealing focus mid-screenshot.
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{\"autoStart\": false}'::jsonb)`,
      [fixture.subject]
    );
    // Enrolled the way e2e/seed.ts enrolls the shared person: with a key
    // and a delegation for the spec's session, the KeyGuard has nothing to
    // ask, so no "write it down" dialog sits over the form.
    await enrollForE2E(client, fixture.subject);
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('admin: the model roster, listing, testing, and saving', async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/llm-models`);
  await expect(page.getByRole('heading', { name: 'Agent models' })).toBeVisible();
  await expect(page.getByText('No models configured yet')).toBeVisible();
  await shot(page, testInfo, 'llm-models-01-empty');

  await page.getByRole('button', { name: '+ Add a model' }).click();
  await page.getByLabel('Display name').fill('Prod Claude');
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByLabel('API key').fill('sk-ant-e2e-fake-key');
  await shot(page, testInfo, 'llm-models-02-draft-filled');

  // "List available models": proves the key can reach the provider's
  // models endpoint. Mocked — no real Anthropic key in e2e.
  await page.route('**/api/admin/**/llm-models/available', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
          { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
        ],
      }),
    });
  });
  await page.getByRole('button', { name: 'List available models' }).click();
  await expect(page.getByRole('button', { name: 'claude-sonnet-5' })).toBeVisible();
  await shot(page, testInfo, 'llm-models-03-listed');

  // "Test connection": one real chat completion in production; here, a
  // mocked success so the exact success copy is what's under test.
  await page.route('**/api/admin/**/llm-models/test', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, model: 'claude-sonnet-5', reply: 'ok' }),
    });
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
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'The provider did not understand the request — check the model id and base URL.',
      }),
    });
  });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    page.getByText('The provider did not understand the request — check the model id and base URL.')
  ).toBeVisible();
  await shot(page, testInfo, 'llm-models-05-tested-error');

  // Fix the model id and actually save — the real POST route, the real DB,
  // the real encrypt-at-rest: this is the save path route.test.ts covers
  // in isolation, now exercised through the form.
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByRole('checkbox', { name: 'Organization default' }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Prod Claude')).toBeVisible();
  await expect(page.getByText('key stored')).toBeVisible();
  await expect(page.getByText('Default', { exact: true })).toBeVisible();
  // Nothing was said about data handling, so the roster warns: a row an
  // operator has not confirmed a BAA for must not look like one they have.
  await expect(page.getByText('Not BAA-covered')).toBeVisible();
  await shot(page, testInfo, 'llm-models-06-saved');

  // Mobile: a resized Chromium viewport, not a device descriptor — the
  // layout question here is "does the form fit and stay usable", which a
  // viewport size answers without pulling in WebKit or a touch profile.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'llm-models-07-mobile-list');
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('Edit model', { exact: true })).toBeVisible();
  await shot(page, testInfo, 'llm-models-08-mobile-edit');
});

test('admin: reasoning effort is free text — no fixed value list — and round-trips through save', async ({
  page,
}, testInfo) => {
  // Its own tenant (AGENTS.md's rule for a spec that writes data): this
  // test saves its own row and must see it as the only one.
  const fixture = fixtureFor(`${testInfo.project.name}-reasoning`);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/llm-models`);
  await page.getByRole('button', { name: '+ Add a model' }).click();
  await page.getByLabel('Display name').fill('Astra Reasoning');
  await page.getByLabel('Provider').selectOption('openai');
  await page.getByLabel('Model id').fill('gpt-6-astra-1');
  await page.getByLabel('API key').fill('sk-e2e-fake-key');

  // Which reasoning_effort values a model accepts is entirely the
  // provider's call and varies by model — one Azure deployment demanded
  // "none" to allow tool calls at all, another rejected "none" outright
  // and only took low/medium/high/xhigh. The field must accept an
  // arbitrary value a fixed dropdown could never enumerate, not just the
  // handful of values known when this form was written.
  const reasoningEffort = page.getByLabel('Reasoning effort');
  await reasoningEffort.fill('xhigh');
  await shot(page, testInfo, 'llm-models-reasoning-effort-freetext');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Astra Reasoning')).toBeVisible();

  // Round-trips through the real save route and DB: reopening the row
  // shows the typed value still there, not stripped back to blank.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('xhigh');
});

test('admin: reasoning effort is offered for a Claude row too, with its own hint, and round-trips', async ({
  page,
}, testInfo) => {
  // Its own tenant, same reasoning as the spec above.
  const fixture = fixtureFor(`${testInfo.project.name}-claude-effort`);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/llm-models`);
  await page.getByRole('button', { name: '+ Add a model' }).click();
  // Anthropic is the default provider: the field is there without switching.
  await expect(page.getByLabel('Provider')).toHaveValue('anthropic');
  const reasoningEffort = page.getByLabel('Reasoning effort');
  await expect(reasoningEffort).toBeVisible();
  // The Claude hint, not the GPT one: on the adaptive generations this is
  // the only dial on how long the model thinks (output_config.effort), and
  // the chat's Thinking switch does not turn thinking off.
  await expect(page.getByText('output_config.effort')).toBeVisible();
  await expect(page.getByText('GPT-5 family')).toHaveCount(0);

  await page.getByLabel('Display name').fill('Sonnet quick');
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByLabel('API key').fill('sk-ant-e2e-fake-key');
  await reasoningEffort.fill('low');
  await shot(page, testInfo, 'llm-models-reasoning-effort-claude');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Sonnet quick')).toBeVisible();

  // Round-trips through the real save route and DB — the payload parser
  // never gated the setting on the provider, only the form did.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('low');

  // Phone width: the field and its hint still fit the form.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByLabel('Reasoning effort')).toBeVisible();
  await shot(page, testInfo, 'llm-models-reasoning-effort-claude-mobile');
});

test('admin: API surface can opt an OpenAI-compatible model into the Responses API', async ({
  page,
}, testInfo) => {
  // Its own tenant, same reasoning as the spec above.
  const fixture = fixtureFor(`${testInfo.project.name}-api-surface`);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/llm-models`);

  // Anthropic (the default provider) never shows the toggle — it's
  // meaningless outside the OpenAI-compatible dialect family.
  await page.getByRole('button', { name: '+ Add a model' }).click();
  await expect(page.getByLabel('API surface')).toHaveCount(0);

  await page.getByLabel('Display name').fill('Astra Responses');
  await page.getByLabel('Provider').selectOption('openai');
  await expect(page.getByLabel('API surface')).toBeVisible();
  await page.getByLabel('Model id').fill('gpt-6-astra-1');
  await page.getByLabel('API key').fill('sk-e2e-fake-key');

  // Some reasoning-model deployments cannot make tool calls on chat
  // completions at any reasoning_effort value — /v1/responses is their
  // only documented path. Selecting it here is what lets resolve.ts pick
  // the Responses API adapter instead of the chat-completions one.
  await page.getByLabel('API surface').selectOption('responses');
  await shot(page, testInfo, 'llm-models-api-surface-responses-selected');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Astra Responses')).toBeVisible();

  // Round-trips through the real save route and DB.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('API surface')).toHaveValue('responses');
});

test('admin: the Images API surface makes an image generation model — never the default, no chat test', async ({
  page,
}, testInfo) => {
  // Its own tenant, same reasoning as the specs above.
  const fixture = fixtureFor(`${testInfo.project.name}-image-model`);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/llm-models`);
  await page.getByRole('button', { name: '+ Add a model' }).click();

  // The Images API is OpenAI's: Anthropic (the default provider) has no such surface to pick.
  await expect(page.getByLabel('API surface')).toHaveCount(0);

  await page.getByLabel('Display name').fill('Painter');
  await page.getByLabel('Provider').selectOption('openai');
  await page.getByLabel('Model id').fill('gpt-image-1');
  await page.getByLabel('API key').fill('sk-e2e-fake-key');

  // Choosing the Images surface takes the model out of the chat-only choices: no default, no chat test.
  const defaultBox = page.getByRole('checkbox', { name: 'Organization default' });
  await defaultBox.check();
  await page.getByLabel('API surface').selectOption('images');
  await expect(page.getByTestId('image-surface-hint')).toBeVisible();
  await expect(defaultBox).toBeDisabled();
  await expect(defaultBox).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  await expect(page.getByText('cannot be tested here')).toBeVisible();
  // The chat-only reasoning hint does not apply to a picture model.
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

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Painter')).toBeVisible();
  // The row says what it is, and it is not the default.
  await expect(page.getByText('Image generation', { exact: true })).toBeVisible();
  await expect(page.getByText('Default', { exact: true })).toHaveCount(0);

  // Round-trips through the real save route and DB.
  await page.getByRole('button', { name: 'Edit' }).click();
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
}, testInfo) => {
  const fixture = fixtureFor(`${testInfo.project.name}-data-handling`);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/llm-models`);
  await page.getByRole('button', { name: '+ Add a model' }).click();
  await page.getByLabel('Display name').fill('Covered Claude');
  await page.getByLabel('Model id').fill('claude-sonnet-5');
  await page.getByLabel('API key').fill('sk-ant-e2e-fake-key');
  // A BAA without a retention term is still a warning: the operator has
  // to say what the provider keeps, not only that a contract exists.
  await page.getByRole('checkbox', { name: /Business Associate Agreement/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Covered Claude')).toBeVisible();
  await expect(page.getByText('Retention unknown')).toBeVisible();
  await shot(page, testInfo, 'llm-models-data-handling-01-retention-unknown');

  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('checkbox', { name: /Business Associate Agreement/ })).toBeChecked();
  await page.getByLabel('Data residency').fill('Azure East US, DataZone');
  await page.getByLabel('Data retention').selectOption('none');
  await page.getByLabel('Notes').fill('BAA signed 2026-01; zero retention confirmed.');
  await shot(page, testInfo, 'llm-models-data-handling-02-filled');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Covered Claude')).toBeVisible();
  await expect(page.getByText('Retention unknown')).toHaveCount(0);
  await expect(page.getByText('Not BAA-covered')).toHaveCount(0);
  await shot(page, testInfo, 'llm-models-data-handling-03-covered');

  // Through the real save route and the settings jsonb, back into the form.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Data residency')).toHaveValue('Azure East US, DataZone');
  await expect(page.getByLabel('Data retention')).toHaveValue('none');
  await expect(page.getByLabel('Notes')).toHaveValue(
    'BAA signed 2026-01; zero retention confirmed.'
  );

  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'llm-models-data-handling-04-mobile-edit');
});
