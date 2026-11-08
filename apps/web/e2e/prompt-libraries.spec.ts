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
import { LLM_STUB_REPLY } from './constants';
import { removeModel, scripted, toolStep } from './support/stub-model';
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

const VARIABLE_PROMPT = [
  'Review {{file}} for {{focus:choice}} in {{areas:multi}}, severity {{severity:number}}.',
  'Notes: {{notes:longtext}}',
  '',
  '```variables',
  'file:',
  '  required: true',
  '  help: Path in the repository',
  'focus:',
  '  options: [security, performance, readability]',
  '  default: security',
  'areas:',
  '  options: [api, ui, db]',
  'severity:',
  '  min: 1',
  '  max: 5',
  '```',
].join('\n');

test('a prompt with variables asks first, then puts the filled-in text in the box', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await makeLibrary(page.request, {
    name: `Forms ${tag}`,
    scope: 'any',
    prompts: [{ title: `Review a file ${tag}`, body: VARIABLE_PROMPT }],
  });
  await page.goto(`/chat/${plainChatId}`);
  await openPicker(page);
  await page.getByRole('option', { name: new RegExp(`Review a file ${tag}`) }).click();

  const form = page.getByRole('dialog');
  await expect(form.getByLabel('File')).toBeVisible();
  // Nothing is in the box yet, and a missing required answer is refused under its field.
  await expect(composer(page)).toHaveValue('');
  await form.getByRole('button', { name: 'Insert' }).click();
  await expect(form.getByText('Needs an answer.')).toBeVisible();
  await expect(composer(page)).toHaveValue('');

  await form.getByLabel('File').fill('src/billing.ts');
  await form.getByLabel('performance').check();
  await form.getByLabel('api').check();
  await form.getByLabel('db').check();
  await form.getByLabel('Severity').fill('4');
  await form.getByRole('button', { name: 'Insert' }).click();

  await expect(form).toBeHidden();
  await expect(composer(page)).toHaveValue(
    'Review src/billing.ts for performance in api, db, severity 4.\nNotes: '
  );
});

test('the assistant asks a form in the chat, and the answers go back as the next message', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/chat/${plainChatId}`);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await composer(page).fill(
    scripted('Plan the review for me.', [
      toolStep('chat_ask_form', {
        intro: 'Two things before I plan it.',
        questions: [
          { question: 'Which file should I review?', required: true, help: 'A path' },
          {
            question: 'What should I focus on?',
            type: 'choice',
            options: ['security', 'performance', 'readability'],
          },
          { question: 'Which areas does it touch?', type: 'multi', options: ['api', 'ui', 'db'] },
        ],
      }),
    ])
  );
  await page.getByRole('button', { name: 'Send' }).filter({ visible: true }).click();

  // The form is drawn in the thread, and the turn is over: nothing was guessed.
  const form = page.getByRole('region', { name: 'Questions for you' });
  await expect(form.getByText('Two things before I plan it.')).toBeVisible({ timeout: 60_000 });
  await expect(form.getByLabel('security')).toBeVisible();

  // A required question left blank is refused under its field; nothing is sent.
  await form.getByRole('button', { name: 'Send answers' }).click();
  await expect(form.getByText('Needs an answer.')).toBeVisible();

  await form.getByLabel('Which file should I review?').fill('src/billing.ts');
  await form.getByLabel('performance').check();
  await form.getByLabel('api').check();
  await form.getByLabel('db').check();
  await form.getByRole('button', { name: 'Send answers' }).click();

  // The answers go to the model as the next turn, but are not a bubble in the thread:
  // the form collapses to one line, opened on a click to what was asked and said.
  await expect(page.getByText(LLM_STUB_REPLY).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('My answers:')).toHaveCount(0);
  const answered = page.getByRole('region', { name: 'Questions for you' });
  const toggle = answered.getByRole('button', { name: /Answered 3 of 3 questions/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(answered.getByRole('button', { name: 'Send answers' })).toHaveCount(0);
  await expect(answered.getByText('src/billing.ts')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(answered.getByText('Which file should I review?')).toBeVisible();
  await expect(answered.getByText('src/billing.ts')).toBeVisible();
  await expect(answered.getByText('performance')).toBeVisible();
  await expect(answered.getByText('api, db')).toBeVisible();

  // After a reload it is the same collapsed record, read back from the stored message.
  await page.reload();
  const again = page.getByRole('region', { name: 'Questions for you' });
  await expect(again.getByRole('button', { name: /Answered 3 of 3 questions/ })).toHaveAttribute(
    'aria-expanded',
    'false',
    { timeout: 30_000 }
  );
  await expect(page.getByText('My answers:')).toHaveCount(0);
  await expect(again.getByRole('button', { name: 'Send answers' })).toHaveCount(0);
});
