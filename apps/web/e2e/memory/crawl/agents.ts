import type { TableRows } from '@renkei/db';
import type { CrawlPage } from './types';
import { crawlId } from './types';

/** Fixed ids for this area's rows (crawlId(100…) is the agents area's range). */
const AGENT = crawlId(101);
const RUN = crawlId(111);
const AT = '2026-01-05T09:00:00.000Z';
const LATER = '2026-01-05T09:01:30.000Z';

/**
 * One agent of the crawl's person with a failed run (its turn, a staged
 * batch, the run-log and ledger rows behind the usage panels), a memory
 * entry and an optimizer report — what the agent pages render. Content
 * is stored unsealed, so no page needs the delegate to open it.
 */
function agentRows(subject: string): TableRows {
  return {
    agents: [
      {
        id: AGENT,
        owner_subject: subject,
        name: 'Crawl agent',
        description: 'Crawl description of the agent',
        description_status: 'ok',
        instructions: '## Goal\n\nCrawl instructions line.',
        tools: JSON.stringify(['jira_search_issues']),
        enabled: true,
        created_at: AT,
        updated_at: AT,
      },
    ],
    agent_triggers: [
      {
        id: crawlId(102),
        agent_id: AGENT,
        kind: 'api',
        config: JSON.stringify({ inputs: [], keyHash: 'crawl', keyHint: 'abcd' }),
        created_at: AT,
      },
    ],
    agent_runs: [
      {
        id: RUN,
        agent_id: AGENT,
        owner_subject: subject,
        trigger_kind: 'crawltrigger',
        status: 'failed',
        error: 'Crawl run error',
        error_kind: 'tool',
        created_at: AT,
        started_at: AT,
        finished_at: LATER,
        initial_state: JSON.stringify({ subject: 'crawl input' }),
        definition_snapshot: JSON.stringify({
          instructions: 'Crawl instructions line.',
          tools: [],
        }),
      },
    ],
    agent_run_steps: [
      {
        id: crawlId(112),
        run_id: RUN,
        step_id: 'turn',
        step_index: 0,
        attempt: 1,
        status: 'failed',
        outcome: 'error',
        detail: JSON.stringify({ llmSummary: 'Crawl turn summary', toolCalls: [] }),
        started_at: AT,
        finished_at: LATER,
      },
    ],
    agent_action_batches: [
      {
        id: crawlId(113),
        run_id: RUN,
        agent_id: AGENT,
        owner_subject: subject,
        turn: 1,
        status: 'declined',
        summary: 'Crawl batch summary',
        actions: JSON.stringify([]),
        created_at: AT,
      },
    ],
    agent_run_log: [
      {
        run_id: RUN,
        agent_id: AGENT,
        owner_subject: subject,
        trigger_kind: 'crawltrigger',
        status: 'failed',
        created_at: AT,
      },
    ],
    llm_calls: [
      {
        id: crawlId(114),
        subject,
        purpose: 'agent_run',
        agent_id: AGENT,
        run_id: RUN,
        provider: 'anthropic',
        model: 'crawl-model',
        input_tokens: 1200,
        output_tokens: 300,
        created_at: AT,
      },
    ],
    tool_calls: [
      {
        id: crawlId(115),
        subject,
        agent_id: AGENT,
        tool: 'jira_search_issues',
        status: 'ok',
        duration_ms: 120,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
    ],
    agent_memories: [
      {
        id: crawlId(116),
        agent_id: AGENT,
        kind: 'entry',
        content: 'Crawl memory note',
        created_at: AT,
      },
    ],
    agent_optimizations: [
      {
        id: crawlId(117),
        agent_id: AGENT,
        owner_subject: subject,
        status: 'failed',
        request: JSON.stringify({ windowDays: 30 }),
        error: 'Crawl optimizer error',
        created_at: AT,
        finished_at: LATER,
      },
    ],
  };
}

/** Pages of this area the memory crawl visits; see ./types.ts. */
export const agentsPages: CrawlPage[] = [
  { path: '/agents', seed: agentRows, expectText: 'Crawl agent' },
  { path: '/agents/new', seed: agentRows, expectText: 'New agent' },
  { path: `/agents/${AGENT}`, seed: agentRows, expectText: 'Crawl instructions line.' },
  { path: `/agents/${AGENT}/edit`, seed: agentRows, expectText: 'Edit “Crawl agent”' },
  { path: `/agents/${AGENT}/runs`, seed: agentRows, expectText: 'via crawltrigger' },
  { path: `/agents/${AGENT}/runs/${RUN}`, seed: agentRows, expectText: 'Crawl run error' },
  { path: '/admin/agents', seed: agentRows, expectText: 'Crawl agent' },
  { path: `/admin/agents/${AGENT}`, seed: agentRows, expectText: 'Crawl description of the agent' },
  { path: `/admin/agents/${AGENT}/runs`, seed: agentRows, expectText: 'via crawltrigger' },
  { path: `/admin/agents/${AGENT}/runs/${RUN}`, seed: agentRows, expectText: 'Crawl run error' },
];
