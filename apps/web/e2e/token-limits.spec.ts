/**
 * Token limits end to end: an operator puts a weekly limit on one model on
 * the Token limits page, a chat on that model spends past it, the next
 * message is refused with the reason, My usage shows the limit and the
 * progress against it, and making the person unlimited lets them go on. A
 * boost is granted and taken back on the person's row, and the page fits a
 * phone.
 *
 * The limit here is on the spec's own model, never the organization's
 * overall limits: those are shared by every test on the one server, and a
 * small one would stop everyone's chats. What the overall limits, boosts
 * and the weekly reset decide is packages/settings/src/token-limits.test.ts;
 * the page's rules are admin/token-limits/token-limits.model.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { createChat, send, startTurn, settled } from './support/chat';
import { addStubModel, removeModel, scripted } from './support/stub-model';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const COLD = { timeout: 30_000 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('a model limit stops new chat turns, shows on My usage, and an operator lifts it @smoke', async ({
  page,
  person,
}, testInfo) => {
  const tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
  const label = `Limited model ${tag}`;
  const modelId = await addStubModel(page.request, tag, { label });
  const personUrl = `/api/admin/token-limits/people/${encodeURIComponent(person.subject)}`;
  try {
    // The operator sets a weekly limit of 3K tokens on the model.
    await page.goto('/admin/token-limits');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Token limits' })).toBeVisible(COLD);
    const save = main.getByRole('button', { name: 'Save limits' });
    await expect(save).toBeDisabled();
    await main.getByRole('textbox', { name: `Weekly limit for ${label}` }).fill('3K');
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/token-limits') && response.request().method() === 'PUT'
    );
    await save.click();
    const request = (await saved).request().postDataJSON();
    // Only the model that changed is sent.
    expect(request).toEqual({ models: { [modelId]: { weekly: 3000, monthly: 0 } } });
    await expect(main.getByText('Saved.')).toBeVisible();

    // Under the limit a turn starts, and spends 5,000 tokens.
    const chatId = await createChat(page.request, { llmModelId: modelId, title: `Limits ${tag}` });
    await send(
      page.request,
      chatId,
      scripted('hello', [{ text: 'Hi.', usage: { input: 4000, output: 1000 } }]),
      modelId
    );

    // Past it, the next message is refused, with the reason on screen.
    await page.goto(`/chat/${chatId}`);
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('One more thing.');
    const refused = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chat/chats/${chatId}/turns`) &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect((await refused).status()).toBe(429);
    await expect(
      page.getByText(`reached the weekly token limit for the model ${label} (5K of 3K)`)
    ).toBeVisible();

    // My usage shows the limit and where the person stands against it.
    await page.goto('/utilization');
    const limits = page.getByRole('main').getByRole('region', { name: 'Token limits' });
    await expect(limits).toBeVisible(COLD);
    const mine = limits.locator(`[data-limit-model="${label}"]`);
    await expect(mine.getByText('5K of 3K')).toBeVisible();
    await expect(mine.getByText(/Limit reached — resets .* UTC/)).toBeVisible();
    await expect(mine.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    // The operator makes the person unlimited: their row says so, and a turn starts again.
    await page.goto('/admin/token-limits');
    await main.getByRole('searchbox', { name: 'Find a person' }).fill(person.subject);
    const row = main.locator(`[data-person="${person.subject}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByText('5K used').first()).toBeVisible();
    await row.getByRole('button', { name: 'Make unlimited' }).click();
    await expect(row.getByText('Unlimited', { exact: true })).toBeVisible();
    await startTurn(page.request, chatId, 'And now?', modelId);
    await settled(page.request, chatId);

    await page.goto('/utilization');
    await expect(limits.getByText('No token limit applies to you.')).toBeVisible(COLD);

    // Back under the limits; a boost is granted on the row, and taken back.
    await page.goto('/admin/token-limits');
    await main.getByRole('searchbox', { name: 'Find a person' }).fill(person.subject);
    await row.getByRole('button', { name: 'Apply limits' }).click();
    await expect(row.getByRole('button', { name: 'Make unlimited' })).toBeVisible();
    await row.getByRole('button', { name: 'Grant boost' }).click();
    const grant = row.getByRole('button', { name: 'Grant', exact: true });
    await expect(grant).toBeDisabled();
    await row.getByRole('textbox', { name: 'Boost tokens' }).fill('500k');
    await row.getByRole('textbox', { name: 'Boost note' }).fill('quarter close');
    await grant.click();
    await expect(row.getByText(/\+500K for the week, until .* UTC — quarter close/)).toBeVisible();
    await row.getByRole('button', { name: 'Take back' }).click();
    await expect(row.getByText(/\+500K for the week/)).toHaveCount(0);

    // Phone width.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(row).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
  } finally {
    await page.request.put('/api/admin/token-limits', { data: { models: { [modelId]: null } } });
    await page.request.put(personUrl, { data: { exempt: false } });
    await removeModel(page.request, modelId);
  }
});
