/**
 * Prompt libraries in the composer's picker, as a person sees them: a
 * library offered in "Code projects only" shows in a code project's chat
 * and not in an ordinary one, a library with many prompts folds and opens,
 * and the keyboard takes a row into the box. The test's own person made
 * the libraries through the routes the library pages call; libraries are
 * per-person, so nothing needs cleaning up.
 *
 * The rules — grouping, folding, search ranking, which row Enter takes —
 * are prompt-picker.model.test.ts's; variables are
 * lib/chat/prompt-variables.test.ts's. Here only what needs a browser:
 * the scope reaching the real picker route, and the keys.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { isRecord } from '@renkei/guards';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { createChat, createCodeProject, setUpCode } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function makeLibrary(
  request: APIRequestContext,
  input: { name: string; scope: 'any' | 'code'; prompts: { title: string; body: string }[] }
): Promise<void> {
  const created = await request.post('/api/chat/prompt-libraries', {
    data: { name: input.name, scope: input.scope },
  });
  expect(created.status(), await created.text()).toBe(201);
  const made: unknown = await created.json();
  const libraryId = isRecord(made) ? made.libraryId : undefined;
  if (typeof libraryId !== 'string') throw new Error(`no libraryId in ${JSON.stringify(made)}`);
  for (const prompt of input.prompts) {
    const added = await request.post(`/api/chat/prompt-libraries/${libraryId}/prompts`, {
      data: prompt,
    });
    expect(added.ok(), await added.text()).toBe(true);
  }
}

const composer = (page: Page) => page.getByLabel('Message').filter({ visible: true });

async function openPicker(page: Page): Promise<void> {
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  const hide = page.getByRole('button', { name: 'Hide the code' });
  if (await hide.isVisible()) await hide.click();
  await page.getByRole('button', { name: 'Insert a prompt' }).filter({ visible: true }).click();
  await expect(page.getByRole('listbox', { name: 'Prompts' })).toBeVisible();
  // The first request to the picker's route can wait on a dev compile.
  await expect(page.getByText('Loading prompts…')).toBeHidden({ timeout: 30_000 });
}

let modelId = '';
let tag = '';
let plainChatId = '';
let codeChatId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  modelId = await setUpCode(page, request, tag);
  const projectId = await createCodeProject(page.request, {
    name: `Prompts service (${tag})`,
    repository: 'acme/prompts',
    branch: 'main',
    description: 'A code project.',
  });
  codeChatId = await createChat(page.request, { projectId, llmModelId: modelId });
  plainChatId = await createChat(page.request, { llmModelId: modelId });
  await makeLibrary(page.request, {
    name: `Everyday ${tag}`,
    scope: 'any',
    prompts: [{ title: `Summarise ${tag}`, body: 'Summarise this thread in three lines.' }],
  });
  await makeLibrary(page.request, {
    name: `Development ${tag}`,
    scope: 'code',
    prompts: [{ title: `Review ${tag}`, body: 'Review the diff for correctness bugs.' }],
  });
});

test.afterEach(async ({ page }) => {
  await removeModel(page.request, modelId);
});

test('a code library is offered in a code project’s chat and not in an ordinary one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(`/chat/${plainChatId}`);
  await openPicker(page);
  const list = page.getByRole('listbox', { name: 'Prompts' });
  await expect(list.getByRole('option', { name: new RegExp(`Summarise ${tag}`) })).toBeVisible();
  await expect(list.getByRole('option', { name: new RegExp(`Review ${tag}`) })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto(`/chat/${codeChatId}`);
  await openPicker(page);
  await expect(list.getByRole('option', { name: new RegExp(`Summarise ${tag}`) })).toBeVisible();
  await expect(list.getByRole('option', { name: new RegExp(`Review ${tag}`) })).toBeVisible();
  // The code library is marked, under its own heading.
  await expect(list.getByRole('region', { name: `Development ${tag}` })).toContainText('code');
});

test('the arrow keys and Enter put a prompt in the box', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/chat/${codeChatId}`);
  await openPicker(page);

  await page.getByPlaceholder('Search prompts').fill(tag);
  // Two libraries, one row each, Development first (libraries sort by name).
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(composer(page)).toHaveValue('Summarise this thread in three lines.');
});

test('a library with many prompts folds, and opens on request', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await makeLibrary(page.request, {
    name: `Long ${tag}`,
    scope: 'any',
    prompts: Array.from({ length: 10 }, (_, i) => ({
      title: `Long prompt ${i} ${tag}`,
      body: `Body ${i}`,
    })),
  });
  await page.goto(`/chat/${plainChatId}`);
  await openPicker(page);

  const section = page.getByRole('region', { name: `Long ${tag}` });
  await expect(section.getByRole('option')).toHaveCount(6);
  await section.getByRole('button', { name: 'Show all 10' }).click();
  await expect(section.getByRole('option')).toHaveCount(10);
  await section.getByRole('button', { name: 'Show fewer' }).click();
  await expect(section.getByRole('option')).toHaveCount(6);
});
