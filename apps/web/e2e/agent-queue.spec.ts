/**
 * An agent's queue, end to end on the in-memory app: while one run is being
 * worked on, the runs behind it wait in the agent's queue, and the runs
 * page's Queue panel says so; cancelling one of the waiting runs lands at
 * once (it has not started), instead of waiting its turn behind them.
 *
 * What the panel says in every state (held, retrying, not picked up,
 * moving, given up on) is queue-panel.model.test.ts's; the queued cancel's
 * rules are run-cancellation.test.ts's; the operator's queue view's picking
 * and halting rules are org-queue.model.test.ts's. The runs are short on purpose: the
 * memory server's agents worker is one serial loop every spec shares.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { createAgent } from './support/agents';
import { addStubModel, removeModel, stubScript } from './support/stub-model';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('runs waiting behind another show in the Queue panel, and a queued run cancels at once', async ({
  page,
  person,
}, testInfo) => {
  test.setTimeout(90_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const agentId = await createAgent(page.request, {
      name: `Queue ${tag}`,
      llmModelId: modelId,
      // Each run's first model reply takes a few seconds, so the next ones queue.
      instructions: `## Goal\n\nTake a moment.\n\n${stubScript([{ text: 'Working', delayMs: 8_000 }])}`,
    });
    const runIds: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const started = await page.request.post(`/api/agents/${agentId}/invoke`, {
        data: { confirm: true },
      });
      expect(started.status(), await started.text()).toBe(202);
      runIds.push((await started.json()).runId);
    }

    // The newest is still queued behind the other two: cancel it from its page.
    await page.goto(`/agents/${agentId}/runs/${runIds[2]}`);
    await expect(page.getByRole('main').getByText('Queued', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '✕ Cancel run' }).click();
    // It had not started: canceled in the request, not "Canceling…" for minutes.
    await expect(page.getByRole('button', { name: 'Canceled' })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('main').getByText('Canceled', { exact: true }).first()
    ).toBeVisible();

    // The runs page says where the rest of the agent's work is.
    await page.goto(`/agents/${agentId}/runs`);
    const queue = page.getByRole('main').locator('details').filter({ hasText: 'Queue' });
    await expect(queue).toContainText('waiting behind it');
    await queue.locator('summary').click();
    await expect(queue).toContainText(/being worked on now|is next/);

    // An operator sees every agent's unfinished runs in one place, and clears one.
    await page.goto('/agents');
    await page.getByRole('link', { name: 'Organization queue →' }).click();
    await expect(page).toHaveURL(/\/admin\/agents\/queue$/);
    const ours = page
      .getByRole('main')
      .getByRole('row')
      .filter({ hasText: `Queue ${tag}` });
    // The two runs left: one being worked on or next, one waiting behind it.
    await expect(ours).toHaveCount(2);
    const queued = ours.filter({ hasText: 'in queue' }).last();
    await expect(queued).toContainText(person.subject);
    const runId = runIds[1];

    // Before Select, a press anywhere on a run opens it.
    await queued.getByRole('cell').nth(2).click();
    await expect(page).toHaveURL(new RegExp(`/admin/agents/${agentId}/runs/${runId}$`));
    await page.goBack();

    // On a phone the runs are cards: while selecting, the whole card picks it.
    await page.setViewportSize({ width: 390, height: 844 });
    const card = page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: `Queue ${tag}` })
      .filter({ hasText: 'in queue' })
      .last();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await card.getByText(`Queue ${tag}`).click();
    await expect(card.getByRole('checkbox')).toBeChecked();
    await expect(page.getByRole('button', { name: 'Halt 1 selected' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });

    // After Select, a press on the run picks it instead, and halts from the bar.
    await expect(page.getByRole('button', { name: /^Select all/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Select all \d/ })).toBeVisible();
    await queued.getByRole('cell').nth(2).click();
    await expect(page).toHaveURL(/\/admin\/agents\/queue$/);
    page.once('dialog', (dialog) => void dialog.accept());
    const halted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/agents/runs/halt') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Halt 1 selected' }).click();
    const answer = await halted;
    expect(answer.status()).toBe(200);
    expect(answer.request().postDataJSON()).toEqual({ runs: [{ agentId, runId }] });
    // Halted runs leave the queue: only the one being worked on (or next) is left.
    await expect(ours).toHaveCount(1);
  } finally {
    await removeModel(page.request, modelId);
  }
});
