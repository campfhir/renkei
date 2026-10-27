/**
 * A code project's chat sits beside the code pane (and the app menu), so at
 * desktop widths its column is far narrower than the window. Checks that the
 * chat keeps a minimum width there, that the composer's row — tools, model,
 * Auto switch, context ring, send — folds its tools into one menu and stays
 * inside the column, and that nothing scrolls sideways. A window width is a
 * resized Chromium viewport (see AGENTS.md's "UI changes").
 *
 * The project and chat are the test's own person's (e2e/support/code-host.ts);
 * a speech provider is configured for the organization (no vendor call);
 * the chat's one reply comes from the stand-in model (e2e/llm-stub.mjs), put
 * on the roster with a context window, so the context ring has a measured
 * reply to show.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import {
  askAndWait,
  connectBitbucket,
  prepareCodeHost,
  stageCodeProject,
} from '../support/code-host';

// The stand-in model is staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const SCREENS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory', 'screens');

let chatId = '';
let modelId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await prepareCodeHost(request);
  await connectBitbucket(page);
  // A speech provider configured for the org, as the old seed had it: the
  // composer folds its tools into one menu only when there is voice to fold
  // in. Nothing here speaks to the vendor; organization-wide, and left on.
  const voice = await page.request.put('/api/admin/connectors/voice', {
    data: {
      provider: 'azure-speech',
      region: 'eastus',
      apiKey: 'e2e-voice-key',
      defaultLocale: 'en-US',
      defaultVoice: 'en-US-AvaMultilingualNeural',
    },
  });
  expect(voice.ok(), await voice.text()).toBe(true);
  // What the composer reads, through the voice route's own cache.
  await expect
    .poll(async () => (await (await page.request.get('/api/voice')).json()).configured, {
      timeout: 70_000,
    })
    .toBe(true);
  // A model with a window and one measured reply, so the context ring shows.
  modelId = await addStubModel(page.request, tag, { contextWindow: 200_000 });
  const { chatIds } = await stageCodeProject(page.request, {
    name: `Tools menu service (${tag})`,
    description: 'A code project.',
    repository: 'acme/chat-width',
    branch: 'main',
    chats: [`Which endpoint posts refunds? (${tag})`],
    llmModelId: modelId,
  });
  chatId = chatIds[0];
  await askAndWait(page.request, chatId, {
    text: 'Which endpoint posts refunds?',
    llmModelId: modelId,
  });
});

test.afterEach(async ({ page }) => {
  await removeModel(page.request, modelId);
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENS, testInfo.project.name, `${name}.png`) });
}

for (const width of [1024, 1280, 1440, 1920]) {
  test(`desktop ${width}: the chat keeps its width and the composer row fits`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/chat/${chatId}`);
    await expect(page.getByLabel('Message')).toBeVisible();
    await expect(page.getByTestId('context-meter')).toBeVisible();
    // The server-rendered page assumes a split; the real layout lands once the
    // client has measured the frame.
    await page.waitForLoadState('networkidle');

    const measure = () =>
      page.evaluate(() => {
        const send = document.querySelector('button[aria-label="Send"]');
        const row = send?.parentElement ?? null;
        const composer = row?.closest('.\\@container') ?? null;
        const rect = (element: Element) => element.getBoundingClientRect();
        return {
          composerWidth: composer ? rect(composer).width : 0,
          composerRight: composer ? rect(composer).right : 0,
          buttons: Array.from(row?.querySelectorAll('button') ?? [])
            .filter((button) => button.offsetParent !== null)
            .map((button) => ({
              label: button.getAttribute('aria-label') ?? button.textContent ?? '',
              right: rect(button).right,
            })),
          sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
    // The pane settles a beat after load (it opens beside a chat with a
    // checkout): measure until two readings agree.
    let layout = await measure();
    await expect
      .poll(async () => {
        const previous = layout.composerWidth;
        layout = await measure();
        return layout.composerWidth === previous;
      })
      .toBe(true);
    // The chat column is at least its minimum; nothing in the row pokes out of it.
    expect(layout.composerWidth).toBeGreaterThanOrEqual(400);
    for (const button of layout.buttons) {
      expect(button.right, button.label).toBeLessThanOrEqual(layout.composerRight);
    }
    expect(layout.sideways).toBeLessThanOrEqual(0);
    // In a column this narrow the tools are the one folded menu, not three buttons.
    if (layout.composerWidth < 480) {
      // The page reads the speech setup through its own cache: a page served
      // just before the org's voice landed there shows it on the next load.
      await expect(async () => {
        if (!(await page.getByRole('button', { name: 'Prompts and voice' }).isVisible())) {
          await page.reload();
        }
        await expect(page.getByRole('button', { name: 'Prompts and voice' })).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 90_000 });
      await expect(page.getByRole('button', { name: 'Insert a prompt' })).toBeHidden();
    }
    await expect(page.getByRole('button', { name: /Auto/ })).toBeVisible();
    await shot(page, testInfo, `code-chat-width-${width}`);
  });
}

test('the saved pane ratio cannot squeeze the chat below its minimum', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('code-pane:ratio', '0.89'));
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const width = await page.getByLabel('Message').evaluate((element) => {
    const column = element.closest('.min-h-0.min-w-0.flex-1');
    return column ? column.getBoundingClientRect().width : 0;
  });
  expect(width).toBeGreaterThanOrEqual(400);
});
