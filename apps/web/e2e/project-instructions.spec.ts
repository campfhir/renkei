/**
 * A chat project's instructions refined, and a loose chat moved into a
 * project, on the real server — what only a browser shows: Refine under
 * the instructions field opens a dialog that sends the draft as it stands
 * to the model and draws the rewrite beside it, Try again in the prompt
 * sends what the prompt says, Accept puts it in the field and Save keeps it
 * (still there after a reload); and the open chat's own ⋯ menu moves it
 * into a project and back out, the header following, at desktop and at
 * phone width.
 *
 * The rules are the model tests': the About form, Refine's states and
 * what it sends (project-about.model.test.ts), the move dialog's choices
 * and a refused move (move-chat-dialog.model.test.ts). The server's are
 * the routes' tests (instructions/refine/route.test.ts, and the move
 * route's in chats/[chatId]/route.test.ts).
 *
 * The model is the stand-in, put on the roster with this test's tag and
 * taken off after; the draft carries the script that makes it answer
 * through propose_instructions (e2e/llm-stub.mjs). The roster the page
 * reads is answered with that stand-in alone (`page.route`), since the
 * real one is shared and moves under a running test. Projects and chats
 * are the person's own.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel, stubScript } from './support/stub-model';
import { renameChat } from './support/chat';

const PHONE = { width: 390, height: 844 };
/** The refine route's first call compiles it on the dev server. */
const COLD = { timeout: 30_000 };

test.describe('project instructions', () => {
  // Putting the stand-in on the roster is an operator's.
  test.use({ roles: ['renkei-user', 'renkei-operator'] });

  test('Refine rewrites the draft in the field, and Save keeps the rewrite', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const modelId = await addStubModel(page.request, tag);
    const refined = `# Hiring (${tag})\n\nYou help run interview loops. Be warm and direct.`;
    try {
      const created = await page.request.post('/api/chat/projects', {
        data: { name: `Hiring ${tag}`, instructions: 'be nice' },
      });
      expect(created.status(), await created.text()).toBe(201);
      const { projectId } = await created.json();

      // The roster is the organization's, and other tests add and remove
      // models on it while this one runs. The dialog asks on whichever model
      // the roster offers first, so one that is removed a moment later is
      // refused ("That model is not available") and no rewrite is drawn. The
      // roster this page reads is answered with this test's stand-in alone.
      await page.route('**/api/chat/models', async (route) => {
        const response = await route.fetch();
        const body: { models: { id: string }[] } = await response.json();
        await route.fulfill({
          response,
          json: {
            ...body,
            models: body.models
              .filter((model) => model.id === modelId)
              .map((model) => ({ ...model, isDefault: true })),
          },
        });
      });

      await page.goto(`/chat/projects/${projectId}`);
      const field = page.getByLabel(/^Instructions/).filter({ visible: true });
      await expect(field).toHaveValue('be nice');
      // An unsaved draft: what Refine works on is the field, not the stored text.
      const draft = `help w/ interviews. be nice\n\n${stubScript([
        {
          oneShot: true,
          tools: [
            {
              name: 'propose_instructions',
              input: { instructions: refined },
            },
          ],
        },
      ])}`;
      // Typed again until React holds it: a fill before the page hydrates is lost.
      await expect(async () => {
        await field.fill(draft);
        await expect(field).toHaveValue(draft, { timeout: 1_000 });
      }).toPass(COLD);

      const refineRequest = () =>
        page.waitForRequest(
          (sent) => sent.url().endsWith('/instructions/refine') && sent.method() === 'POST'
        );
      // Opening the dialog asks at once, with the draft as it stands.
      const [first] = await Promise.all([
        refineRequest(),
        page.getByRole('button', { name: 'Refine', exact: true }).click(),
      ]);
      expect(JSON.stringify(first.postDataJSON())).toContain('help w/ interviews');
      // It asks on this test's own model, which nobody else removes.
      expect(first.postDataJSON()).toMatchObject({ llmModelId: modelId });
      const dialog = page.getByRole('dialog', { name: 'Refine instructions' });
      await expect(dialog.getByLabel('Original instructions')).toContainText('help w/ interviews');
      const recommended = dialog.getByLabel('Recommended instructions');
      await expect(recommended).toHaveText(refined, COLD);

      // Try again sits in the prompt and sends what it says, on the model chosen.
      await dialog.getByLabel(/Anything to change/).fill('make it warmer');
      // The roster is the org's: pick this test's own stand-in when there is a choice.
      const select = dialog.getByLabel('Model');
      if (await select.count()) await select.selectOption(modelId);
      const [again] = await Promise.all([
        refineRequest(),
        dialog.getByRole('button', { name: 'Try again' }).click(),
      ]);
      expect(again.postDataJSON()).toMatchObject({
        guidance: 'make it warmer',
        llmModelId: modelId,
      });
      await expect(recommended).toHaveText(refined);

      await dialog.getByRole('button', { name: 'Accept' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(field).toHaveValue(refined);
      await expect(page.getByText(/Refined, not saved yet/)).toBeVisible();

      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/chat/projects/${projectId}`) &&
            response.request().method() === 'PATCH'
        ),
        page.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
      expect(saved.ok()).toBe(true);
      await expect(page.getByText(/Refined, not saved yet/)).toHaveCount(0);
      await page.reload();
      await expect(page.getByLabel(/^Instructions/).filter({ visible: true })).toHaveValue(refined);

      // Phone width: the dialog fits, the original stacked over the recommendation.
      await page.setViewportSize(PHONE);
      // The saved text carries no script now: the stand-in answers its fixed reply.
      await page.getByRole('button', { name: 'Refine', exact: true }).click();
      await expect(recommended).toBeVisible(COLD);
      const original = await dialog.getByLabel('Original instructions').boundingBox();
      const proposed = await recommended.boundingBox();
      expect((original?.x ?? 0) + (original?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
      expect(proposed?.y ?? 0).toBeGreaterThan((original?.y ?? 0) + (original?.height ?? 0));
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByLabel(/^Instructions/).filter({ visible: true })).toHaveValue(refined);
    } finally {
      await removeModel(page.request, modelId);
    }
  });
});

test('the open chat’s menu moves it into a project and back out', async ({
  page,
  person: _person,
}) => {
  const project = await page.request.post('/api/chat/projects', {
    data: { name: 'Budget planning' },
  });
  expect(project.status(), await project.text()).toBe(201);
  // A chat in no project, as "New chat" makes it (no model named: the org's default).
  const created = await page.request.post('/api/chat/chats', { data: {} });
  expect(created.status(), await created.text()).toBe(201);
  const { chatId } = await created.json();
  await renameChat(page.request, chatId, 'Q3 numbers');

  await page.goto(`/chat/${chatId}`);
  const header = page.locator('header').filter({ visible: true });
  await expect(page.getByRole('heading', { level: 1, name: 'Q3 numbers' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Budget planning' })).toHaveCount(0);

  const moveTo = async (target: string) => {
    await header.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to project…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move to project' });
    const [moved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/chat/chats/${chatId}/move`) &&
          response.request().method() === 'POST'
      ),
      dialog.getByRole('button', { name: target, exact: true }).click(),
    ]);
    expect(moved.ok(), await moved.text()).toBe(true);
    await expect(dialog).toHaveCount(0);
  };

  await moveTo('Budget planning');
  await expect(header.getByRole('link', { name: 'Budget planning' })).toBeVisible();

  // Phone width: the same menu, the dialog on screen, and back out of the project.
  await page.setViewportSize(PHONE);
  await moveTo('No project');
  await expect(header.getByRole('link', { name: 'Budget planning' })).toHaveCount(0);
});
