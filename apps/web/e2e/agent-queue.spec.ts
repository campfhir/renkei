/**
 * An agent's queue, end to end on the in-memory app: while one run is being
 * worked on, the runs behind it wait in the agent's queue, and the runs
 * page's Queue panel says so; cancelling one of the waiting runs lands at
 * once (it has not started), instead of waiting its turn behind them.
 *
 * What the panel says in every state (held, retrying, not picked up,
 * moving, given up on) is queue-panel.model.test.ts's; the queued cancel's
 * rules are run-cancellation.test.ts's. The runs are short on purpose: the
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
  person: _person,
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
  } finally {
    await removeModel(page.request, modelId);
  }
});
