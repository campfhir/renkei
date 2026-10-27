import { expect } from '@playwright/test';
import { LLM_STUB_REPLY } from '../constants';
import { addStubModel, removeModel } from '../../support/stub-model';
import { agentOf, field, send, type CrawlPage, type CrawlStage } from './types';

/**
 * The agent pages: one agent of the crawl's person, made through the
 * builder's route, and — for the pages that show runs — one run of it,
 * started the way "Run now" starts one and carried out by the agents
 * worker the memory server runs in-process, on the stand-in model (staged
 * on the roster, tagged, and removed again afterwards).
 */

// Agent names are unique across the organization: each carries the test's tag.
async function agent({ api, tag }: CrawlStage): Promise<string> {
  return agentOf(api, `Crawl agent ${tag}`);
}

async function agentWithRun(stage: CrawlStage): Promise<{ agentId: string; runId: string }> {
  const { api, tag, cleanup } = stage;
  const modelId = await addStubModel(api, tag);
  cleanup(() => removeModel(api, modelId));
  const agentId = await agentOf(api, `Crawl agent ${tag}`, { llmModelId: modelId });
  const runId = field(await send(api, 'post', `/api/agents/${agentId}/invoke`, {}), 'runId');
  // The run is the worker's: wait until its page reads it finished.
  await expect
    .poll(async () => (await api.get(`/agents/${agentId}/runs/${runId}`)).text(), {
      timeout: 30_000,
    })
    .toContain(LLM_STUB_REPLY);
  return { agentId, runId };
}

export const agentsPages: CrawlPage[] = [
  {
    path: '/agents',
    stage: async (stage) => {
      await agent(stage);
    },
    expectText: 'Crawl agent',
  },
  { path: '/agents/new', expectText: 'New agent' },
  {
    path: '/agents/[agentId]',
    stage: async (stage) => `/agents/${await agent(stage)}`,
    expectText: 'Crawl instructions line.',
  },
  {
    path: '/agents/[agentId]/edit',
    stage: async (stage) => `/agents/${await agent(stage)}/edit`,
    expectText: /^Edit “Crawl agent crawl-/,
  },
  {
    path: '/agents/[agentId]/runs',
    stage: async (stage) => `/agents/${(await agentWithRun(stage)).agentId}/runs`,
    expectText: 'via manual',
  },
  {
    path: '/agents/[agentId]/runs/[runId]',
    stage: async (stage) => {
      const { agentId, runId } = await agentWithRun(stage);
      return `/agents/${agentId}/runs/${runId}`;
    },
    expectText: LLM_STUB_REPLY,
  },
  {
    path: '/admin/agents',
    stage: async (stage) => {
      await agent(stage);
    },
    expectText: 'Crawl agent',
  },
  {
    path: '/admin/agents/[agentId]',
    stage: async (stage) => `/admin/agents/${await agent(stage)}`,
    expectText: 'Crawl agent',
  },
  {
    path: '/admin/agents/[agentId]/runs',
    stage: async (stage) => `/admin/agents/${(await agentWithRun(stage)).agentId}/runs`,
    expectText: 'via manual',
  },
  {
    path: '/admin/agents/[agentId]/runs/[runId]',
    stage: async (stage) => {
      const { agentId, runId } = await agentWithRun(stage);
      return `/admin/agents/${agentId}/runs/${runId}`;
    },
    expectText: 'Succeeded',
  },
];
