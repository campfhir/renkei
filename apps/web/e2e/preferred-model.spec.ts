/**
 * Models as a person meets them: the composer's picker on a long roster,
 * the model a new chat starts on, and what happens to the people on a
 * model when an operator removes it.
 *
 * Where the rules went:
 *   - the picker — what a search keeps, what the arrow keys and Enter act
 *     on, when a pick closes the menu, where the menu sits and how tall it
 *     may be — is chat/_components/model-select.model.test.ts;
 *   - which model a new chat starts on (its project's, else in a code
 *     project its owner's preferred code project model, else its owner's
 *     preferred chat model, else the organization default; a pick no
 *     longer on offer passed over) is lib/chat/preferred-model.test.ts,
 *     and the pickers that set them are
 *     preferences/chat-model-form.model.test.ts,
 *     preferences/code-model-form.model.test.ts and
 *     chat/_components/project-model.model.test.ts;
 *   - the removal dialog's wording, options and request are
 *     admin/llm-models/model-forms.model.test.ts; what the server moves,
 *     refuses and writes to each person is
 *     api/admin/llm-models/[modelId]/route.test.ts and
 *     lib/agents/model-removed-notification.test.ts.
 *
 * What stays is what only a browser shows: the menu inside a phone's
 * screen with its list scrolling in it, a searched pick reaching the
 * server, a saved preference and a project's model on the next chat's
 * composer, and the removal end to end — the dialog, the delete, the
 * note on the other person's Notifications page.
 *
 * The roster is organization-wide: every model here carries the test's
 * own tag and goes again afterwards.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createPerson, signIn } from './support/person';
import { addStubModel, removeModel } from './support/stub-model';
import {
  connectBitbucket,
  createChat,
  createCodeProject,
  prepareCodeHost,
} from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

let tag = '';
let added: string[] = [];
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
  added = [];
});

test.afterEach(async ({ page, person: _person }) => {
  for (const id of added) {
    // One the test removed through the page is already gone.
    const listed = await page.request.get('/api/admin/llm-models');
    const { models } = await listed.json();
    if (models.some((model: { id: string }) => model.id === id)) {
      await removeModel(page.request, id);
    }
  }
});

async function addModel(page: Page, name: string): Promise<{ id: string; label: string }> {
  const label = `${name} ${tag}`;
  const id = await addStubModel(page.request, tag, { label });
  added.push(id);
  return { id, label };
}

/** The composer's model button, which names the model in use. */
const modelButton = (page: Page) => page.getByRole('button', { name: 'Model', exact: true });

test('chat: the model picker searches a long roster and stays inside a phone screen', async ({
  page,
  person: _person,
}) => {
  const names = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel', 'Ivy'];
  const models = [];
  for (const name of names) models.push(await addModel(page, name));
  const ginkgo = models[6]!;

  await page.goto('/chat/new');
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
  await modelButton(page).click();
  const menu = page.getByRole('menu', { name: 'Model' });
  await expect(menu).toBeVisible();

  // A search narrows the roster to this test's one model; picking it is
  // saved on the chat.
  await menu.getByRole('searchbox', { name: 'Search models' }).fill(`ginkgo ${tag}`);
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
  const saved = page.waitForResponse(
    (response) =>
      /\/api\/chat\/chats\/[0-9a-f-]{36}$/.test(response.url()) &&
      response.request().method() === 'PATCH'
  );
  await menu.getByRole('menuitemradio', { name: new RegExp(ginkgo.label) }).click();
  expect((await saved).request().postDataJSON()).toEqual({ llmModelId: ginkgo.id });
  await expect(menu).toBeHidden();
  await expect(modelButton(page)).toContainText(ginkgo.label);

  // A search nothing matches says so instead of showing an empty box.
  await modelButton(page).click();
  await menu.getByRole('searchbox', { name: 'Search models' }).fill(`no such model ${tag}`);
  await expect(menu.getByRole('status')).toContainText('No model matches');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // On a short phone screen the menu ends inside the screen on every
  // side, and the roster scrolls inside it.
  await page.setViewportSize({ width: 390, height: 600 });
  await modelButton(page).click();
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  const list = menu.getByTestId('model-list');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The last of this test's models is reached by scrolling the list, not the page.
  const last = menu.getByRole('menuitemradio', { name: new RegExp(models[8]!.label) });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('chat: a new chat starts on the preferred model, and on its project’s own first', async ({
  page,
  person: _person,
}) => {
  const preferred = await addModel(page, 'Preferred');
  const projects = await addModel(page, 'Projects');

  // Preferences: pick the model new chats start on.
  await page.goto('/preferences/models');
  const section = page.getByRole('region', { name: 'Chat model' });
  await section.getByLabel('Preferred chat model').selectOption(preferred.id);
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();

  await page.goto('/chat/new');
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
  await expect(modelButton(page)).toContainText(preferred.label);

  // A project with no model of its own: its chats take the preference.
  const created = await page.request.post('/api/chat/projects', {
    data: { name: `Model project ${tag}` },
  });
  expect(created.status()).toBe(201);
  const { projectId } = await created.json();
  await page.goto(`/chat/new?project=${projectId}`);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
  await expect(modelButton(page)).toContainText(preferred.label);

  // Give the project its own model: its next chat starts on that one.
  await page.goto(`/chat/projects/${projectId}`);
  const picker = page.getByLabel('Model — what new chats in this project start on');
  const patched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chat/projects/${projectId}`) &&
      response.request().method() === 'PATCH'
  );
  await picker.selectOption(projects.id);
  expect((await patched).ok()).toBe(true);
  await expect(picker).toBeEnabled();
  await page.getByRole('main').getByRole('link', { name: 'New chat', exact: true }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
  await expect(modelButton(page)).toContainText(projects.label);
});

test('code: a new chat in a code project starts on the preferred code project model', async ({
  page,
  request,
  person: _person,
}) => {
  const chats = await addModel(page, 'Chats');
  const code = await addModel(page, 'Code');
  await prepareCodeHost(request);
  await connectBitbucket(page);
  const projectId = await createCodeProject(page.request, {
    name: `Model code project ${tag}`,
    repository: `acme/model-${tag}`,
    branch: 'main',
  });
  const preferring = await page.request.patch('/api/preferences', {
    data: { chatModel: { modelId: chats.id } },
  });
  expect(preferring.ok(), await preferring.text()).toBe(true);

  // With no code project model picked, a code chat takes the chat model.
  await page.goto(`/chat/${await createChat(page.request, { projectId })}`);
  await expect(modelButton(page)).toContainText(chats.label);

  // Preferences › Code projects: "same as my chat model" names it; pick another.
  await page.goto('/preferences/code');
  const section = page.getByRole('region', { name: 'Code project model' });
  const picker = section.getByLabel('Preferred code project model');
  await expect(picker.locator('option').first()).toHaveText(
    `Same as my chat model (${chats.label})`
  );
  await picker.selectOption(code.id);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/preferences') && response.request().method() === 'PATCH'
  );
  await section.getByRole('button', { name: 'Save' }).click();
  expect((await saved).request().postDataJSON()).toEqual({ codeModel: { modelId: code.id } });
  await expect(section.getByText('Saved.')).toBeVisible();

  // The next chat in the code project starts on it; a chat outside one does not.
  await page.goto(`/chat/${await createChat(page.request, { projectId })}`);
  await expect(modelButton(page)).toContainText(code.label);
  await page.goto('/chat/new');
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
  await expect(modelButton(page)).toContainText(chats.label);
});

test('admin: removing a model moves the people on it to a replacement and tells them', async ({
  page,
  person: _person,
  browser,
  request,
}) => {
  const going = await addModel(page, 'Going');
  const staying = await addModel(page, 'Staying');

  // Somebody else prefers the model and has a chat on it.
  const other = await createPerson(request, { displayName: `Model User ${tag}` });
  const preferring = await request.patch('/api/preferences', {
    headers: other.headers,
    data: { chatModel: { modelId: going.id } },
  });
  expect(preferring.ok(), await preferring.text()).toBe(true);
  const chat = await request.post('/api/chat/chats', {
    headers: other.headers,
    data: { llmModelId: going.id },
  });
  expect(chat.status()).toBe(201);
  const { chatId } = await chat.json();

  // Remove asks who is on it, offers a replacement, and says they will be told.
  await page.goto('/admin/llm-models');
  await page.getByRole('button', { name: `Remove ${going.label}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Remove “${going.label}”` });
  await expect(
    dialog.getByText(`Model User ${tag} is on this model: 1 preferred chat model and 1 chat.`)
  ).toBeVisible();
  await dialog.getByLabel('Replace it with').selectOption(staying.id);
  const removed = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/llm-models/${going.id}`) &&
      response.request().method() === 'DELETE'
  );
  await dialog.getByRole('button', { name: 'Remove and notify 1 person' }).click();
  const answer = await removed;
  expect(new URL(answer.url()).searchParams.get('replaceWith')).toBe(staying.id);
  expect(await answer.json()).toEqual({ deleted: true, notified: 1 });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('button', { name: `Remove ${going.label}`, exact: true })
  ).toHaveCount(0);

  // The other person: told on their Notifications page, their preference
  // and their chat on the replacement.
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await signIn(context, other);
  const theirs = await context.newPage();
  await theirs.goto('/notifications');
  await expect(
    theirs.getByText(
      `An administrator removed the model "${going.label}". "${staying.label}" replaced it for your preferred chat model and 1 chat.`
    )
  ).toBeVisible();
  await theirs.goto(`/chat/${chatId}`);
  await expect(modelButton(theirs)).toContainText(staying.label);
  await theirs.goto('/preferences/models');
  await expect(
    theirs.getByRole('region', { name: 'Chat model' }).getByLabel('Preferred chat model')
  ).toHaveValue(staying.id);
  await context.close();
});
