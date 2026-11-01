/**
 * The service desk "create request" card (jsm_create_request_preview).
 *
 * The request type's own form decides what the card shows: its required
 * fields and its pick lists (components, priority) appear as controls that
 * read in labels, while the ids the API needs stay in the card's hidden
 * arguments. Real as far as the browser: Jira Service Management connected
 * through the fake OAuth, a chat turn on the stand-in model calling the
 * preview, the real widget bundle; the sandbox stub answers the desk's
 * request type form (e2e/sandbox-stub.mjs). Only the confirm button's
 * `tools/call` is answered at the browser edge.
 *
 * Kept here: one press through the real card — pick in labels, confirm,
 * and the ids go out — plus what only a browser shows (the search box
 * drawn above the chips, the card at a phone's width). The rules moved:
 * what the preview holds (labels resolved to ids, "(required)", the desk
 * and type by name) is lib/mcp-tools/jira-service-management/jsm.test.ts;
 * what the card makes of it — pick lists, chips offered and added, the
 * ids each pick sends, a blank required field — is lib/mcp-widgets/src/
 * issue-preview.model.test.ts, and the chips box's own rules are
 * chips.model.test.ts.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectThrough, registerConnector } from './support/connectors';
import { send } from './support/chat';
import { addStubModel, removeModel, scripted } from './support/stub-model';
import { createChat } from './support/tool-cards';

const COLD = { timeout: 30_000 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

let modelId = '';

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

function cardFrame(page: Page) {
  return page.getByRole('main').frameLocator('iframe[title="Preview card"]');
}

async function openCard(page: Page, testInfo: TestInfo): Promise<string> {
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await registerConnector(page.request, 'atlassian-jsm', {
    clientId: 'e2e-atlassian-jsm-client',
    clientSecret: 'e2e-atlassian-jsm-secret',
  });
  await connectThrough(page, '/api/atlassian-jsm/authorize');
  modelId = await addStubModel(page.request, tag);
  const title = `JSM create card (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  const configured = await page.request.patch(`/api/chat/chats/${chatId}`, {
    data: { toolConfig: { connectors: ['jira'] } },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const view = await send(
    page.request,
    chatId,
    scripted('Raise an incident for the printer.', [
      {
        text: 'Here is a preview — nothing is created until you confirm.',
        tools: [
          {
            name: 'jsm_create_request_preview',
            input: {
              serviceDeskId: 'HELP',
              requestTypeId: '9001',
              summary: 'Printer on floor 2 is down',
              components: ['Billing'],
            },
          },
        ],
      },
      { text: 'Waiting on your decision.' },
    ]),
    modelId,
    { allow: true, timeout: 120_000 }
  );
  const refused = view.messages
    .flatMap((message) => message.blocks)
    .filter((block) => JSON.stringify(block).includes('"isError":true'));
  expect(refused, JSON.stringify(refused)).toEqual([]);
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  return chatId;
}

test('picking in labels on the card confirms the ids behind them', async ({
  page,
  person: _person,
}, testInfo) => {
  const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    confirmCall.value = route.request().postDataJSON();
    await route.fulfill({
      json: {
        result: {
          content: [{ type: 'text', text: 'Created request HELP-7' }],
          isError: false,
          meta: {},
        },
      },
    });
  });
  await openCard(page, testInfo);

  const frame = cardFrame(page);
  await expect(frame.locator('.card-title')).toHaveText('Create service desk request', COLD);
  const impact = frame.locator('.field', { hasText: 'Impact (required)' });
  await expect(impact.locator('option')).toHaveText(['—', 'Single user', 'Whole site']);
  // Scoped to the visible copy: a built card can hold a hidden twin of a field, and a
  // press lands on what is drawn, so a click on the hidden one leaves the chip in place.
  const components = frame.locator('.field', { hasText: 'Components' }).filter({ visible: true });
  await expect(components.locator('.chip')).toHaveText(['Billing×']);
  // The search sits above the chips.
  const searchBox = await components.getByRole('combobox', { name: 'Components' }).boundingBox();
  const chipBox = await components.locator('.chip').first().boundingBox();
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(chipBox!.y);

  await impact.locator('select').selectOption({ label: 'Whole site' });
  await frame.locator('.field', { hasText: 'Priority' }).locator('select').selectOption({
    label: 'High',
  });
  const search = components.getByRole('combobox', { name: 'Components' });
  await search.fill('Platform');
  await expect(components.locator('.chip')).toHaveText(['Billing×', 'Platform×']);
  // Out of the box, so Chrome's suggestion popup for it is closed before
  // the next press: a press while it is open only dismisses it.
  await search.blur();
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      'jsm-create-request-card.png'
    ),
    fullPage: true,
  });

  await frame.getByRole('button', { name: 'Create request' }).click();
  await expect(frame.locator('.done-headline')).toHaveText('Created request HELP-7');

  // The model's tool call carries the ids behind the labels.
  expect(confirmCall.value?.name).toBe('jsm_create_request_confirm');
  expect(confirmCall.value?.arguments).toMatchObject({
    requestTypeId: '9001',
    priority: '2',
    components: ['10042', '10043'],
    formFields: { customfield_10010: '20002' },
  });
});

test('the card holds on a phone-width viewport', async ({ page, person: _person }, testInfo) => {
  await openCard(page, testInfo);
  await page.setViewportSize(MOBILE_VIEWPORT);
  const frame = cardFrame(page);
  await expect(frame.locator('.field', { hasText: 'Impact (required)' })).toBeVisible(COLD);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
});
