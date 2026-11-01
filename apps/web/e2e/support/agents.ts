/**
 * Agents for a spec, made and run the way the app does it: the builder's
 * route (POST /api/agents) and "Run now"'s (POST /api/agents/:id/invoke).
 * The run itself is carried out by the agents worker the memory server
 * runs in-process, against the stand-in model (e2e/llm-stub.mjs).
 *
 * `stubScript` (./stub-model.ts) in an agent's instructions has the
 * run's model calls go the way its steps say — a read tool,
 * stage_actions, ask_person — before the stub's default finish_run.
 *
 * Agent names are unique across the organization: pass one carrying the
 * spec's own tag.
 */

import { expect, type APIRequestContext } from '@playwright/test';

export interface AgentDraft {
  name: string;
  instructions: string;
  tools?: string[];
  llmModelId?: string;
  canAskQuestions?: boolean;
  autoAcceptActions?: boolean;
  /** Default: switched on with an API trigger, so it can be run by hand. */
  enabled?: boolean;
  triggers?: unknown[];
}

export async function createAgent(request: APIRequestContext, draft: AgentDraft): Promise<string> {
  const enabled = draft.enabled ?? true;
  const created = await request.post('/api/agents', {
    data: {
      tools: [],
      triggers: enabled ? [{ draft: { kind: 'api', inputs: [] }, enabled: true }] : [],
      ...draft,
      enabled,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body: unknown = await created.json();
  const agentId =
    typeof body === 'object' && body !== null && 'agentId' in body ? body.agentId : null;
  if (typeof agentId !== 'string') throw new Error(`POST /api/agents: ${JSON.stringify(body)}`);
  return agentId;
}

/** What "Run now" sends; answers the queued run's id. */
export async function runAgent(request: APIRequestContext, agentId: string): Promise<string> {
  const started = await request.post(`/api/agents/${agentId}/invoke`, { data: {} });
  expect(started.status(), await started.text()).toBe(202);
  const body: unknown = await started.json();
  const runId = typeof body === 'object' && body !== null && 'runId' in body ? body.runId : null;
  if (typeof runId !== 'string') throw new Error(`invoke: ${JSON.stringify(body)}`);
  return runId;
}

/**
 * Wait for a run to finish and answer its final status, as the run page's
 * own live view learns it: the run's stream route sends the run on each
 * change and closes once it settles, so its body is complete when the run
 * is.
 */
export async function runSettled(
  request: APIRequestContext,
  agentId: string,
  runId: string,
  timeout = 60_000
): Promise<string> {
  const response = await request.get(`/api/agents/${agentId}/runs/${runId}/stream`, { timeout });
  expect(response.ok(), `run stream: ${response.status()}`).toBe(true);
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice('data: '.length)));
  const last = events.at(-1);
  const run = typeof last === 'object' && last !== null ? Reflect.get(last, 'run') : undefined;
  const status = typeof run === 'object' && run !== null ? Reflect.get(run, 'status') : undefined;
  expect(typeof status, `no run in the stream's last event`).toBe('string');
  return String(status);
}

export interface FeedItem {
  id: string;
  kind: string;
  status: string;
  title: string;
  result: unknown;
  suggested_action: unknown;
}

/** The person's cards as the feed's own route answers them, archived ones included. */
export async function feedItems(request: APIRequestContext): Promise<FeedItem[]> {
  const response = await request.get('/api/actionable-items?archived=1');
  const body: unknown = await response.json();
  const items =
    typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items)
      ? body.items
      : [];
  return items.flatMap((item: unknown) =>
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    typeof item.id === 'string' &&
    'title' in item &&
    typeof item.title === 'string' &&
    'status' in item &&
    typeof item.status === 'string' &&
    'kind' in item &&
    typeof item.kind === 'string'
      ? [
          {
            id: item.id,
            kind: item.kind,
            status: item.status,
            title: item.title,
            result: 'result' in item ? item.result : null,
            suggested_action: 'suggested_action' in item ? item.suggested_action : null,
          },
        ]
      : []
  );
}
