/**
 * Agents in chat, end to end on the in-memory app: the person picks one
 * of their agents with `@` in a chat's composer, the message goes out
 * addressed to it (the turn request names the agent), the chat hands it
 * the task (`chat_ask_agent`, scripted on the stand-in model) without a
 * permission card — the person addressed it — and the agent's run, carried
 * out by the in-process agents worker on the stand-in model, comes back
 * as its reply on the card in the thread. Also: a project's Team panel
 * adds and removes an agent, and a phone-width pass over the card.
 *
 * What the picker offers and in what order, what the chip and card say in
 * each state, and the team's rules are the model tests'
 * (agent-mention.model.test.ts, agent-ask-card.model.test.ts,
 * project-team.model.test.ts).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel, scripted, toolStep } from './support/stub-model';
import { createAgent } from './support/agents';
import { createChat } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const shot = (projectName: string, name: string) =>
  path.join(import.meta.dirname, '..', 'test-results', 'screens', projectName, name);

test('@-mentioning an agent hands it the task, and its reply lands on the card @smoke', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const agentName = `Triage ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  // Unscripted, the agent's run finishes at once with the stub's summary.
  const agentId = await createAgent(page.request, {
    name: agentName,
    instructions: 'Look into what you are asked and reply with what you found.',
    llmModelId: modelId,
  });
  const task = 'Find who owns INC-42 and whether it is still open.';
  try {
    const chatId = await createChat(page.request, {
      llmModelId: modelId,
      title: `Who owns INC-42? ${tag}`,
    });
    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');

    // The empty chat names the agent; the composer's @ offers it.
    await expect(main.getByRole('button', { name: `Ask ${agentName}` })).toBeVisible();
    const box = main.getByRole('textbox', { name: 'Message' });
    await box.fill('@Tri');
    const list = page.getByRole('listbox', { name: 'Agents you can ask' });
    await list.getByRole('option', { name: new RegExp(agentName) }).click();
    await expect(
      main.locator('[data-agent-addressee]', { hasText: `To ${agentName}` })
    ).toBeVisible();

    // The chat's model hands the task over, then says so.
    await box.fill(
      scripted(task, [
        toolStep('chat_ask_agent', { agent_id: agentId, task }, 'Handing this to the agent.'),
        { text: 'The agent is on it; its reply will show here.' },
      ])
    );
    const turn = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && /\/api\/chat\/chats\/[^/]+\/turns$/.test(request.url())
    );
    await box.press('Enter');
    const body: unknown = (await turn).postDataJSON();
    expect(body).toMatchObject({
      agentId,
      text: expect.stringMatching(new RegExp(`^@${agentName} `)),
    });

    // No permission card: the person addressed the agent themselves.
    const card = main.locator('[data-agent-ask]');
    // It appears once the chat's model has called chat_ask_agent.
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(agentName, { exact: true })).toBeVisible();
    // The send went through: the next message is for the chat again.
    await expect(
      main.locator('[data-agent-addressee]', { hasText: `To ${agentName}` })
    ).toHaveCount(0);
    await expect(card.locator('[data-agent-ask-reply]')).toContainText(LLM_STUB_REPLY, {
      timeout: 30_000,
    });
    await expect(card.locator('[data-agent-ask-status]')).toHaveText(`${agentName} replied`);
    await expect(card.getByRole('link', { name: 'View run' })).toHaveAttribute(
      'href',
      new RegExp(`/agents/${agentId}/runs/[0-9a-f-]+$`)
    );
    await page.screenshot({ path: shot(testInfo.project.name, 'chat-agents-01-replied.png') });

    // Reply addresses the composer back to the agent.
    await card.getByRole('button', { name: `Reply to ${agentName}` }).click();
    await expect(
      main.locator('[data-agent-addressee]', { hasText: `To ${agentName}` })
    ).toBeVisible();

    // A phone: the card and the chip fit the width.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await page.request.delete(`/api/agents/${agentId}`);
    await removeModel(page.request, modelId);
  }
});

test('a project’s Team panel adds one of your agents and takes it off again', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const agentName = `Billing ${tag}`;
  const agentId = await createAgent(page.request, {
    name: agentName,
    instructions: 'Answer billing questions.',
  });
  try {
    const project = await page.request.post('/api/chat/projects', {
      data: { name: `Billing cleanup ${tag}` },
    });
    expect(project.status(), await project.text()).toBe(201);
    const { projectId } = await project.json();
    await page.goto(`/chat/projects/${projectId}`);

    const team = page.getByRole('main').locator('[data-project-team]');
    await expect(team.getByText('Add the agents that work on this project')).toBeVisible();
    await team.getByRole('button', { name: 'Add an agent' }).click();
    const added = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/api/chat/projects/${projectId}/agents`)
    );
    await team.getByRole('button', { name: `Add ${agentName} to the team` }).click();
    expect((await added).status()).toBe(201);
    const members = team.getByRole('list', { name: 'Agents on this project' });
    await expect(members.getByText(agentName)).toBeVisible();
    await expect(members.getByText('Your agent', { exact: true })).toBeVisible();

    // It survives a reload: the team is the project's.
    await page.reload();
    await expect(members.getByText(agentName)).toBeVisible();

    await team.getByRole('button', { name: `Take ${agentName} off the team` }).click();
    await expect(members).toHaveCount(0);
    await expect(team.getByText('Add the agents that work on this project')).toBeVisible();
  } finally {
    await page.request.delete(`/api/agents/${agentId}`);
  }
});
