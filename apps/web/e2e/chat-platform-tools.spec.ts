/**
 * The chat's own tools for Renkei itself (lib/chat/platform-tools/), on the
 * real server: the person asks the chat to switch to dark mode with line
 * numbers, the model calls renkei_set_preferences, the thread asks first
 * (it acts), and once allowed the page the person is looking at follows —
 * `<html data-theme>` turns dark and the reply's code block grows its
 * gutter, with no reload. The preference is the saved one: a full load
 * paints it again. The link the model was handed for the Preferences page
 * starts with the address this browser reached the app at.
 *
 * Only that path is here. Which tools a turn has, what each refuses, what
 * find_tools lists and whose library a person may change are
 * lib/chat/platform-tools/platform-tools.test.ts's; which documents
 * re-render what is app/(app)/preferences-sync.model.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel, scripted, toolStep } from './support/stub-model';
import { createChat, readChat } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const COLD = { timeout: 30_000 };
const ANSWER = 'Dark mode is on, with line numbers.';

test('the model changes a preference on the person’s word and the open page follows', async ({
  page,
  person,
}, testInfo) => {
  void person;
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await createChat(page.request, {
      llmModelId: modelId,
      title: `Dark mode please ${tag}`,
    });
    await page.goto(`/chat/${chatId}`);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill(
      scripted('Switch me to dark mode and show line numbers in code.', [
        toolStep('renkei_set_preferences', { theme: { mode: 'dark', codeLineNumbers: true } }),
        toolStep('renkei_link', { to: 'preferences' }),
        { text: `${ANSWER}\n\n\`\`\`ts\nconst theme = 'dark';\n\`\`\`` },
      ])
    );
    await box.press('Enter');

    // Changing a preference acts: the thread asks before it runs.
    const ask = page.getByRole('group', { name: 'Permission needed' });
    await expect(ask).toBeVisible(COLD);
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(async () => {
      await ask.getByRole('button', { name: 'Allow once' }).click({ timeout: 2_000 });
      await expect(ask).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // The page follows as the tool returns: no reload, no navigation.
    await expect(html).toHaveAttribute('data-theme', 'dark', COLD);
    await expect(page.getByText(ANSWER).filter({ visible: true })).toBeVisible(COLD);
    await expect(page.getByRole('main').locator('.chat-code.line-numbers')).toBeVisible(COLD);

    // It is the saved preference, not a look this tab put on.
    const saved = await page.request.get('/api/preferences');
    expect((await saved.json()).theme).toEqual({ mode: 'dark', codeLineNumbers: true });
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('main').locator('.chat-code.line-numbers')).toBeVisible(COLD);

    // The link the model was handed starts where this browser reached the app.
    const origin = new URL(page.url()).origin;
    const { messages } = await readChat(page.request, chatId);
    expect(JSON.stringify(messages)).toContain(`${origin}/preferences`);
  } finally {
    await removeModel(page.request, modelId);
  }
});
