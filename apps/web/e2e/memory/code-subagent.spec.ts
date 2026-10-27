/**
 * A code chat's sub-agent and the model it ran on: the orchestrator sent
 * it on a cheaper model of the org's (`code_delegate`'s `model`,
 * lib/code/delegate.ts), so its card in the thread says which, and the
 * run's transcript (lib/chat/subagent-runs.ts, migration 118) names the
 * model that actually answered, by the config's label.
 *
 * All of it runs for real on the in-memory app: the project and chat are
 * the test's own person's (e2e/support/code-host.ts), the org's two models
 * are the stand-in (e2e/llm-stub.mjs) under two labels, and the stand-in
 * calls the tools the prompt scripts — the orchestrator `code_delegate`
 * on the "fast" model, the sub-agent `code_grep` in the checkout — before
 * each answers with its fixed reply. Also a viewport pass at phone width.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from '../support/stub-model';
import { askAndWait, setUpCode, stageCodeProject } from '../support/code-host';

// The stand-in models are staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const TASK = 'Find every place the invoice job’s retry count is read or written.';
const PROMPT = 'Why does the invoice job retry forever?';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the card names the model the orchestrator picked; the transcript names what answered', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const shot = (name: string) =>
    page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        '..',
        'test-results',
        'memory',
        'screens',
        testInfo.project.name,
        name
      ),
      fullPage: false,
    });
  const modelId = await setUpCode(page, request, tag);
  // The org's cheaper model, the one the orchestrator sends the sub-agent on.
  const fastModelId = await addStubModel(page.request, `fast-${tag}`);
  const fastModelLabel = `Stub model fast-${tag}`;
  try {
    const { chatIds } = await stageCodeProject(page.request, {
      name: `Billing service (sub-agent ${tag})`,
      description: 'Invoices and the nightly jobs.',
      repository: 'acme/billing-service',
      branch: 'main',
      chats: [`Why does the invoice job retry? (sub-agent ${tag})`],
      llmModelId: modelId,
    });
    const chatId = chatIds[0];
    // The sub-agent's task scripts its own one grep; the orchestrator's
    // prompt scripts the delegation.
    const delegate = JSON.stringify({
      task: `${TASK}\nstub:call code_grep {"pattern":"retryCount"}`,
      readOnly: true,
      model: fastModelLabel,
    });
    await askAndWait(
      page.request,
      chatId,
      { text: `${PROMPT}\nstub:call code_delegate ${delegate}`, llmModelId: modelId },
      120_000
    );

    const main = page.getByRole('main');
    await page.goto(`/chat/${chatId}`);
    await expect(main.getByText(PROMPT)).toBeVisible();

    // ── The sub-agent's card, folded: the model it was sent on, beside
    //    its read-only mark and the first line of its report ──
    const subagent = main.locator('details[data-subagent]');
    await expect(subagent).toContainText('Sub-agent reported');
    await expect(subagent).toContainText('read-only');
    await expect(subagent.locator('[data-subagent-model]')).toHaveText(`on ${fastModelLabel}`);
    await subagent.locator('> summary').click();
    await expect(subagent).toHaveAttribute('open', '');
    await expect(subagent.getByText(LLM_STUB_REPLY, { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-subagent-card.png');

    // ── Its transcript: the model that actually answered, by the config's
    //    label with the provider and model name behind it, the counts, and
    //    the sub-agent's own steps ──
    await subagent.getByRole('button', { name: 'View transcript' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sub-agent' });
    // Two model calls: the grep, then the report.
    await expect(dialog).toContainText(/2 of \d+ model calls · 1 tool call/);
    // How long it ran: its start to its finish, the run being over.
    await expect(dialog.locator('[data-subagent-elapsed]')).toHaveText(/^ran for \d/);
    const model = dialog.locator('[data-subagent-model]');
    await expect(model).toHaveText(`on ${fastModelLabel}`);
    await expect(model).toHaveAttribute('title', 'openai stub-model');
    await expect(dialog.getByText(TASK, { exact: false })).toBeVisible();
    // The grep is the sub-agent's own step (the stub worker answers no grep,
    // so the step reads failed — which step it was is what is shown here).
    await expect(dialog.getByText(/Search code/).first()).toBeVisible();
    // Where its time went: each model call's own duration on its heading,
    // and the tool call's on its line.
    await expect(dialog.locator('[data-model-call-duration]').first()).toHaveText(/^· /);
    await expect(dialog.locator('[data-call-duration]')).toHaveText(/s$/);
    await shot('code-chat-subagent-transcript.png');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // ── Phone width: the same card and the same line, nothing overflowing ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(main.getByText(PROMPT)).toBeVisible();
    const narrow = main.locator('details[data-subagent]');
    await expect(narrow.locator('[data-subagent-model]')).toHaveText(`on ${fastModelLabel}`);
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-subagent-mobile.png');
  } finally {
    await removeModel(page.request, fastModelId);
    await removeModel(page.request, modelId);
  }
});
