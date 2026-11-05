/**
 * A chat project's instructions refined, and a loose chat moved into a
 * project, on the real server — what only a browser shows: Refine under
 * the instructions field sends the draft as it stands to the model and
 * draws the proposal, "Use this" puts it in the field and Save keeps it
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
 * through propose_instructions (e2e/llm-stub.mjs). Projects and chats are
 * the person's own.
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

      await page.goto(`/chat/projects/${projectId}`);
      const field = page.getByLabel(/^Instructions/);
      await expect(field).toHaveValue('be nice');
      // An unsaved draft: what Refine works on is the field, not the stored text.
      const draft = `help w/ interviews. be nice\n\n${stubScript([
        {
          oneShot: true,
          tools: [
            {
              name: 'propose_instructions',
              input: { instructions: refined, changes: ['Added a heading'] },
            },
          ],
        },
      ])}`;
      // Typed again until React holds it: a fill before the page hydrates is lost.
      await expect(async () => {
        await field.fill(draft);
        await expect(field).toHaveValue(draft, { timeout: 1_000 });
      }).toPass(COLD);

      await page.getByRole('button', { name: 'Refine', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Refine instructions' });
      await panel.getByLabel(/Anything in particular/).fill('make it warmer');
      const ask = panel.getByRole('button', { name: 'Refine', exact: true });
      await expect(ask).toBeEnabled();
      // The roster is the org's: pick this test's own stand-in when there is a choice.
      const select = panel.getByLabel('Model');
      if (await select.count()) await select.selectOption(modelId);

      const [request] = await Promise.all([
        page.waitForRequest(
          (sent) => sent.url().endsWith('/instructions/refine') && sent.method() === 'POST'
        ),
        ask.click(),
      ]);
      const body: unknown = request.postDataJSON();
      expect(body).toMatchObject({ guidance: 'make it warmer', llmModelId: modelId });
      expect(JSON.stringify(body)).toContain('help w/ interviews');

      await expect(panel.getByLabel('Proposed instructions')).toHaveText(refined, COLD);
      await expect(panel.getByText('Added a heading')).toBeVisible();
      await panel.getByRole('button', { name: 'Use this' }).click();
      await expect(panel).toHaveCount(0);
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
      await expect(page.getByLabel(/^Instructions/)).toHaveValue(refined);

      // Phone width: the panel opens under the field and fits.
      await page.setViewportSize(PHONE);
      await page.getByRole('button', { name: 'Refine', exact: true }).click();
      await expect(panel).toBeInViewport({ ratio: 0.5 });
      const box = await panel.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
      await panel.getByRole('button', { name: 'Cancel' }).click();
      await expect(panel).toHaveCount(0);
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
