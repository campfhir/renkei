/**
 * An agent run, end to end on the in-memory app: the agent created through
 * the agent builder's own route (POST /api/agents), "Run now" pressed on
 * its overview, and the run carried out by the agents worker the memory
 * server runs in-process (lib/memory-workers.ts) — claimed the moment the
 * button enqueued it, its one model call answered by the stand-in model
 * (e2e/llm-stub.mjs) — until its page shows it finished, with the
 * summary the model gave.
 *
 * The model is staged through the admin roster's route, tagged, never the
 * default, named on the agent, and removed again afterwards: the roster
 * is everybody's.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from '../support/stub-model';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('Run now runs the agent to the end, and its page shows the finished run', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const created = await page.request.post('/api/agents', {
      data: {
        name: `Stub runner ${tag}`,
        instructions: 'Say that the work is finished, then finish the run.',
        tools: [],
        // An agent is switched on only with a trigger; an API one needs nothing else.
        triggers: [{ draft: { kind: 'api', inputs: [] }, enabled: true }],
        enabled: true,
        llmModelId: modelId,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { agentId } = await created.json();

    await page.goto(`/agents/${agentId}`);
    await expect(page.getByRole('heading', { name: `Stub runner ${tag}` })).toBeVisible();
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByRole('link', { name: 'Run started — open it' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/runs/[0-9a-f-]+$`));

    // The run page follows the run live; reload until it is no longer in flight.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(LLM_STUB_REPLY).first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible();
    await page.screenshot({
      path: path.join(RESULTS, 'screens', testInfo.project.name, 'agent-run-01-finished.png'),
      fullPage: true,
    });
  } finally {
    await removeModel(page.request, modelId);
  }
});
