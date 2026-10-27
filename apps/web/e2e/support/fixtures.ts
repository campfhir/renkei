/**
 * e2e/seed.ts's shared, deterministic fixtures, written through the store
 * methods the application writes them with — no table rows, no SQL. Run
 * once per memory server by e2e/support/global-setup.ts; idempotent, so a
 * reused dev server keeps what it has.
 *
 * What gets written, and by what:
 *  - the shared person E2E_SUBJECT on session E2E_SESSION_ID (an operator):
 *    identities.upsert, sessions.create, and real key enrollment through
 *    the server's delegate (./person.ts) — sign in with
 *    `test.use({ storageState: SHARED_STORAGE_STATE })`;
 *  - the org's sandbox feature settings (settings.set), and the connectors
 *    it has switched on (connectorConfigs.upsert);
 *  - a Jira grant for the person (providerGrants.upsertSealed), so the tool
 *    catalog enumerates Jira tools;
 *  - three agents (agents.create, saveDescription, applyTriggerChanges,
 *    saveMemorySummary / addMemoryEntry) and their runs in every state, the
 *    way the engine moves a run: agentRuns.createQueued, updateExecution,
 *    openTurn / writeTurn, stageBatch → settleProposedBatch → claimBatch →
 *    completeBatch, finishExecution;
 *  - the run log, the token and voice ledgers and the tool-call log over a
 *    year (logRunCreated / recordOutcome, usage.recordLlmCall / recordVoice,
 *    toolUsage.recordCall), and the event monitor's rows (queues.enqueue,
 *    claim, complete / retry / deadLetter).
 *
 * Every call that stamps "now" is run as of the moment the fixture
 * describes (`asOf`, e2e/support/store.ts), so "26 hours ago" is 26 hours
 * ago here exactly as in e2e/seed.ts.
 *
 * Knowledge notes are NOT seeded, as in e2e/seed.ts.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { Json } from '@renkei/db';
import { createPerson } from './person';
import { dataStore, dataStoreBatch, type RemoteDataStore } from './store';

export const E2E_TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const E2E_SLUG = 'e2e';
export const E2E_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const E2E_SUBJECT = 'e2e-user@example.com';

export const AGENT_RICH_ID = '33333333-3333-4333-8333-333333333333';
export const AGENT_PLAIN_ID = '44444444-4444-4444-8444-444444444444';
export const AGENT_DEEP_ID = '99999999-9999-4999-8999-999999999999';

export const RUN_SUCCEEDED_ID = '66666666-6666-4666-8666-666666666661';
export const RUN_STEP_FAILED_ID = '66666666-6666-4666-8666-666666666662';
export const RUN_TIMEOUT_ID = '66666666-6666-4666-8666-666666666663';
export const RUN_RUNNING_ID = '66666666-6666-4666-8666-666666666664';
export const RUN_ITERATIONS_ID = '66666666-6666-4666-8666-666666666665';
export const RUN_PARKED_ID = '66666666-6666-4666-8666-666666666666';

export const TRIGGER_RICH = '55555555-5555-4555-8555-555555555551';
export const TRIGGER_PLAIN = '55555555-5555-4555-8555-555555555552';

/** The staged batch the deep agent's run proposed and the executor carried out. */
export const BATCH_DEEP_ID = '12121212-1212-4121-8121-121212121212';

/**
 * The rich agent: structured instructions under every section heading, and
 * Jira tools on purpose — the Jira connector is provisioned for every
 * caller (unlike grant-gated connectors), so the builder shows this agent
 * fully valid, reads and changes alike.
 */
const RICH_INSTRUCTIONS = [
  '## Goal',
  '',
  'Every weekday, review yesterday’s Jira activity and file a follow-up ticket in OPS for each item that needs one.',
  '',
  '## Context',
  '',
  'Runs on a schedule. The OPS project is where infrastructure follow-ups live.',
  '',
  '## Approach',
  '',
  '1. Search yesterday’s updated issues.',
  '2. Pick out the ones nobody has followed up on.',
  '3. Propose one OPS ticket per item, linking the original.',
  '',
  '## Tools',
  '',
  'Use `jira_search_issues` to find activity and `jira_get_issue` for detail.',
  '',
  '## Actions',
  '',
  'Create OPS tickets with `jira_create_issue`: a one-line summary and a link to the source issue.',
  '',
  '## Done when',
  '',
  'Every item that needs a follow-up has a proposed ticket — or there was nothing to follow up.',
  '',
  '## Rules',
  '',
  '- Never file a duplicate: check for an existing OPS ticket first.',
].join('\n');
const RICH_TOOLS = ['jira_search_issues', 'jira_get_issue', 'jira_create_issue'];

const PLAIN_INSTRUCTIONS = [
  '## Goal',
  '',
  'Write a three-line summary of yesterday’s activity.',
].join('\n');

const DEEP_INSTRUCTIONS = [
  '## Goal',
  '',
  'Work the open request queue: escalate what is critical, acknowledge what is routine.',
  '',
  '## Approach',
  '',
  '1. Search the open requests.',
  '2. Judge how urgent each one is.',
  '3. Propose an escalation comment on critical ones and an acknowledgement on routine ones, all in one batch.',
  '',
  '## Done when',
  '',
  'Every open request has a proposed comment.',
].join('\n');
const DEEP_TOOLS = ['jira_search_issues', 'jira_add_comment'];

const REVIEW_NOTES = [
  {
    issue:
      'The instructions never say what to do when an item already has an OPS ticket in progress.',
    fix: 'Add a rule under Rules: comment on the existing ticket instead of proposing a new one.',
  },
];

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

/** Engine-shaped turn detail — keys match run-timeline.tsx's reader. */
function turnDetail(input: {
  opening?: string;
  llmSummary?: string;
  toolCalls?: {
    tool: string;
    argsPreview: string;
    resultPreview: string;
    durationMs: number;
    isError?: boolean;
    free?: boolean;
    staged?: number;
  }[];
  finish?: 'done' | 'nothing_to_do' | 'failed';
  result?: string;
  modelCalls?: {
    durationMs: number;
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
  }[];
}): string {
  return JSON.stringify(input);
}

const model = (ms: number) => [
  { durationMs: ms, stopReason: 'tool_use', inputTokens: 900, outputTokens: 60 },
];
const TURN_ROWS: {
  runId: string;
  turn: number;
  status: string;
  outcome: string | null;
  toolCallCount: number;
  detail: string | null;
  at: Date;
}[] = [
  {
    runId: RUN_SUCCEEDED_ID,
    turn: 1,
    status: 'succeeded',
    outcome: null,
    toolCallCount: 1,
    detail: turnDetail({
      opening: 'Your schedule started this run. Work toward your goal now.',
      llmSummary: 'Looking up yesterday’s updated issues.',
      toolCalls: [
        {
          tool: 'jira_search_issues',
          argsPreview: '{"jql":"updated >= -1d"}',
          resultPreview: 'OPS-231: VPN outage (no follow-up)',
          durationMs: 640,
        },
      ],
      modelCalls: model(2100),
    }),
    at: hoursAgo(26),
  },
  {
    runId: RUN_SUCCEEDED_ID,
    turn: 2,
    status: 'succeeded',
    outcome: 'done',
    toolCallCount: 0,
    detail: turnDetail({
      llmSummary: 'OPS-231 already has a follow-up — nothing new to file.',
      toolCalls: [
        {
          tool: 'finish_run',
          argsPreview: '{"outcome":"done"}',
          resultPreview: '',
          durationMs: 0,
          free: true,
        },
      ],
      finish: 'done',
      modelCalls: model(1400),
    }),
    at: hoursAgo(25.95),
  },
  {
    runId: RUN_STEP_FAILED_ID,
    turn: 1,
    status: 'succeeded',
    outcome: null,
    toolCallCount: 1,
    detail: turnDetail({
      opening: 'Your schedule started this run. Work toward your goal now.',
      llmSummary: 'Searching yesterday’s activity.',
      toolCalls: [
        {
          tool: 'jira_search_issues',
          argsPreview: '{"jql":"updated >= -1d"}',
          resultPreview: 'OPS-240: printer queue stuck',
          durationMs: 590,
        },
      ],
      modelCalls: model(1900),
    }),
    at: hoursAgo(2),
  },
  {
    runId: RUN_STEP_FAILED_ID,
    turn: 2,
    status: 'succeeded',
    outcome: 'failed',
    toolCallCount: 1,
    detail: turnDetail({
      llmSummary: 'Could not file the follow-up: the OPS project rejected the issue type “Task”.',
      toolCalls: [
        {
          tool: 'jira_get_issue',
          argsPreview: '{"issueKey":"OPS-240"}',
          resultPreview: 'Issue type Task is not valid in OPS',
          durationMs: 310,
          isError: true,
        },
        {
          tool: 'finish_run',
          argsPreview: '{"outcome":"failed"}',
          resultPreview: '',
          durationMs: 0,
          free: true,
        },
      ],
      finish: 'failed',
      modelCalls: model(1700),
    }),
    at: hoursAgo(1.95),
  },
  {
    runId: RUN_TIMEOUT_ID,
    turn: 1,
    status: 'failed',
    outcome: null,
    toolCallCount: 1,
    detail: turnDetail({
      opening: 'Your schedule started this run. Work toward your goal now.',
      llmSummary: 'Paging through every updated issue.',
      toolCalls: [
        {
          tool: 'jira_search_issues',
          argsPreview: '{"jql":"updated >= -1d"}',
          resultPreview: '50 of 1,204 results',
          durationMs: 900,
        },
      ],
      modelCalls: model(2400),
    }),
    at: hoursAgo(50),
  },
  {
    runId: RUN_RUNNING_ID,
    turn: 1,
    status: 'running',
    outcome: null,
    toolCallCount: 0,
    detail: null,
    at: hoursAgo(0.05),
  },
  {
    runId: RUN_ITERATIONS_ID,
    turn: 1,
    status: 'succeeded',
    outcome: null,
    toolCallCount: 1,
    detail: turnDetail({
      opening: 'Your owner started this run by hand. Work toward your goal now.',
      llmSummary: 'Finding the open requests.',
      toolCalls: [
        {
          tool: 'jira_search_issues',
          argsPreview: '{"jql":"status = Open"}',
          resultPreview: 'OPS-301 (VPN outage), OPS-302 (laptop request)',
          durationMs: 733,
        },
      ],
      modelCalls: model(2000),
    }),
    at: hoursAgo(5),
  },
  {
    runId: RUN_ITERATIONS_ID,
    turn: 2,
    status: 'succeeded',
    outcome: null,
    toolCallCount: 2,
    detail: turnDetail({
      llmSummary: 'OPS-301 is critical, OPS-302 routine — proposing both comments in one batch.',
      toolCalls: [
        {
          tool: 'stage_actions',
          argsPreview: '{"summary":"Escalate one, acknowledge one"}',
          resultPreview: 'Accepted.',
          durationMs: 0,
          staged: 2,
        },
      ],
      modelCalls: model(2600),
    }),
    at: hoursAgo(4.97),
  },
  {
    runId: RUN_ITERATIONS_ID,
    turn: 3,
    status: 'succeeded',
    outcome: 'done',
    toolCallCount: 0,
    detail: turnDetail({
      llmSummary: 'Both comments were made. The queue is worked.',
      toolCalls: [
        {
          tool: 'finish_run',
          argsPreview: '{"outcome":"done"}',
          resultPreview: '',
          durationMs: 0,
          free: true,
        },
      ],
      finish: 'done',
      result: 'Escalated OPS-301; acknowledged OPS-302.',
      modelCalls: model(1100),
    }),
    at: hoursAgo(4.92),
  },
];

const OTHER_SUBJECT = 'e2e-colleague@example.com';
const TOOL_CALL_ROWS: {
  tool: string;
  connector: string;
  subject: string;
  calls: number;
  failures: number;
  ms: number;
}[] = [
  {
    tool: 'jira_search_issues',
    connector: 'jira',
    subject: E2E_SUBJECT,
    calls: 24,
    failures: 2,
    ms: 420,
  },
  {
    tool: 'jira_get_issue',
    connector: 'jira',
    subject: E2E_SUBJECT,
    calls: 17,
    failures: 0,
    ms: 180,
  },
  {
    tool: 'search_knowledge',
    connector: 'knowledge',
    subject: E2E_SUBJECT,
    calls: 11,
    failures: 0,
    ms: 950,
  },
  {
    tool: 'jira_add_comment',
    connector: 'jira',
    subject: E2E_SUBJECT,
    calls: 6,
    failures: 3,
    ms: 260,
  },
  {
    tool: 'outlook_list_messages',
    connector: 'microsoft',
    subject: E2E_SUBJECT,
    calls: 4,
    failures: 1,
    ms: 610,
  },
  {
    tool: 'webex_send_message',
    connector: 'webex',
    subject: E2E_SUBJECT,
    calls: 2,
    failures: 0,
    ms: 310,
  },
  // Somebody else's usage, which outweighs the viewer's on two tools.
  {
    tool: 'outlook_list_messages',
    connector: 'microsoft',
    subject: OTHER_SUBJECT,
    calls: 39,
    failures: 4,
    ms: 580,
  },
  {
    tool: 'confluence_search',
    connector: 'atlassian-confluence',
    subject: OTHER_SUBJECT,
    calls: 28,
    failures: 0,
    ms: 700,
  },
  {
    tool: 'jira_search_issues',
    connector: 'jira',
    subject: OTHER_SUBJECT,
    calls: 9,
    failures: 5,
    ms: 450,
  },
  {
    tool: 'zoom_list_meetings',
    connector: 'zoom',
    subject: OTHER_SUBJECT,
    calls: 5,
    failures: 0,
    ms: 350,
  },
];

const RUN_ROWS: {
  id: string;
  status: string;
  errorKind: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  activeMs: number;
}[] = [
  {
    id: RUN_SUCCEEDED_ID,
    status: 'succeeded',
    errorKind: null,
    error: null,
    startedAt: hoursAgo(26),
    finishedAt: hoursAgo(25.9),
    activeMs: 41_000,
  },
  {
    id: RUN_STEP_FAILED_ID,
    status: 'failed',
    errorKind: 'agent_failed',
    error: 'Could not file the follow-up: the OPS project rejected the issue type “Task”.',
    startedAt: hoursAgo(2),
    finishedAt: hoursAgo(1.9),
    activeMs: 52_000,
  },
  {
    id: RUN_TIMEOUT_ID,
    status: 'failed',
    errorKind: 'timeout',
    error: 'The run used its 30 minutes of active time.',
    startedAt: hoursAgo(50),
    finishedAt: hoursAgo(49),
    activeMs: 1_800_000,
  },
  {
    id: RUN_RUNNING_ID,
    status: 'running',
    errorKind: null,
    error: null,
    startedAt: hoursAgo(0.05),
    finishedAt: null,
    activeMs: 3_000,
  },
  // Parked by the engine: the owner's key was not delegated when the
  // schedule fired (docs/delegate-key-design.md, phase 3).
  {
    id: RUN_PARKED_ID,
    status: 'waiting',
    errorKind: 'needs-sign-in',
    error: 'Paused: your encryption key is not available to your agents. Sign in to resume.',
    startedAt: null,
    finishedAt: null,
    activeMs: 0,
  },
];

/** The run log's and the ledgers' spread: [days ago, runs, failures], as e2e/seed.ts has it. */
const SPREAD: [number, number, number][] = [
  [0, 3, 1],
  [1, 2, 1],
  [2, 4, 0],
  [12, 6, 2],
  [70, 9, 0],
  [320, 20, 5],
];

const LEDGER_STEPS: {
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}[] = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    input: 3580,
    output: 210,
    cacheRead: 2400,
    cacheWrite: 0,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    input: 3650,
    output: 640,
    cacheRead: 0,
    cacheWrite: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    input: 1200,
    output: 95,
    cacheRead: 480,
    cacheWrite: 0,
  },
  { provider: null, model: null, input: 310, output: 40, cacheRead: 0, cacheWrite: 0 },
];

function spreadAt(daysAgo: number, minutes: number): Date {
  return new Date(Date.now() - daysAgo * 86_400_000 - minutes * 60_000);
}

const SANDBOX_FEATURES = [
  'sandbox_browser_enabled',
  'sandbox_charts_enabled',
  'sandbox_workspaces_enabled',
  'sandbox_services_enabled',
];

const CONNECTORS_ON = [
  'atlassian',
  'atlassian-jsm',
  'atlassian-confluence',
  'webex-user',
  'microsoft',
  'zoom',
];

const JIRA_SCOPES = [
  'read:issue:jira',
  'write:issue:jira',
  'read:user:jira',
  'read:project:jira',
  'read:jql:jira',
  'read:field:jira',
  'read:comment:jira',
  'write:comment:jira',
  'read:board-scope:jira-software',
];

/** One agent's definition, as the builder saves it, then its description as the describer stores it. */
function writeAgent(
  store: RemoteDataStore,
  agent: {
    id: string;
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    enabled: boolean;
    reviewNotes: Json;
  }
): void {
  void store.agents.create({
    id: agent.id,
    ownerSubject: E2E_SUBJECT,
    name: agent.name,
    instructions: agent.instructions,
    tools: agent.tools,
    llmModelId: null,
    enabled: agent.enabled,
    guardrails: null,
    canAskQuestions: false,
    autoAcceptActions: false,
  });
  void store.agents.saveDescription(agent.id, {
    status: 'ok',
    description: agent.description,
    reviewNotes: agent.reviewNotes,
  });
}

/** The agents, their triggers and memory, their runs and turns, and the deep run's batch. */
function writeAgents(batch: ReturnType<typeof dataStoreBatch>): void {
  const store = batch.store;
  writeAgent(store, {
    id: AGENT_RICH_ID,
    name: 'Triage yesterday into tickets',
    description:
      'Every weekday morning this agent reviews yesterday’s Jira activity, picks out what needs follow-up, and files a ticket for each item in the OPS project.',
    instructions: RICH_INSTRUCTIONS,
    tools: RICH_TOOLS,
    enabled: true,
    reviewNotes: REVIEW_NOTES,
  });
  writeAgent(store, {
    id: AGENT_PLAIN_ID,
    name: 'Daily activity digest',
    description: 'Writes a short summary of the previous day.',
    instructions: PLAIN_INSTRUCTIONS,
    tools: [],
    enabled: false,
    reviewNotes: null,
  });
  writeAgent(store, {
    id: AGENT_DEEP_ID,
    name: 'Sweep the request queue',
    description:
      'Goes through every open request, escalates the critical ones, acknowledges the routine ones, and writes a note per request.',
    instructions: DEEP_INSTRUCTIONS,
    tools: DEEP_TOOLS,
    enabled: false,
    reviewNotes: null,
  });

  const scheduleConfig = JSON.stringify({
    recurrences: [{ every: 'weekday', at: '09:00' }],
    timezone: 'UTC',
  });
  for (const [agentId, id, enabled, nextRunAt] of [
    [AGENT_RICH_ID, TRIGGER_RICH, true, hoursAgo(-20)],
    [AGENT_PLAIN_ID, TRIGGER_PLAIN, false, null],
  ] as const) {
    void store.agents.applyTriggerChanges(agentId, {
      update: [],
      remove: [],
      insert: [
        {
          id,
          kind: 'schedule',
          eventSource: null,
          eventType: null,
          config: scheduleConfig,
          enabled,
          nextRunAt,
        },
      ],
    });
  }

  void store.agents.saveMemorySummary({
    id: '77777777-7777-4777-8777-777777777771',
    agentId: AGENT_RICH_ID,
    content:
      'The OPS project is the right home for infrastructure requests; HR questions go to the PEOPLE desk instead.',
  });
  void batch.asOf(hoursAgo(25)).agents.addMemoryEntry({
    id: '77777777-7777-4777-8777-777777777772',
    agentId: AGENT_RICH_ID,
    content: 'Filed OPS-231 for the VPN outage thread; sender confirmed it covered their ask.',
    runId: null,
  });
  void batch.asOf(hoursAgo(1)).agents.addMemoryEntry({
    id: '77777777-7777-4777-8777-777777777773',
    agentId: AGENT_RICH_ID,
    content: 'Skipped the newsletter digest — recurring, never actionable.',
    runId: null,
  });

  const snapshot = { instructions: RICH_INSTRUCTIONS, tools: RICH_TOOLS };
  for (const run of RUN_ROWS) {
    const createdAt = run.startedAt ?? new Date();
    void batch.asOf(createdAt).agentRuns.createQueued({
      id: run.id,
      agentId: AGENT_RICH_ID,
      ownerSubject: E2E_SUBJECT,
      triggerId: TRIGGER_RICH,
      triggerKind: 'schedule',
      triggeredBySubject: null,
      parentRunId: null,
      lineage: [],
      definitionSnapshot: snapshot,
      llmModelId: null,
      initialState: null,
    });
  }
  void batch.asOf(hoursAgo(5)).agentRuns.createQueued({
    id: RUN_ITERATIONS_ID,
    agentId: AGENT_DEEP_ID,
    ownerSubject: E2E_SUBJECT,
    triggerId: null,
    triggerKind: 'manual',
    triggeredBySubject: E2E_SUBJECT,
    parentRunId: null,
    lineage: [],
    definitionSnapshot: { instructions: DEEP_INSTRUCTIONS, tools: DEEP_TOOLS },
    llmModelId: null,
    initialState: null,
  });

  // The executor picks each run up…
  for (const run of [...RUN_ROWS, { id: RUN_ITERATIONS_ID, startedAt: hoursAgo(5) }]) {
    if (!run.startedAt) continue;
    void batch
      .asOf(run.startedAt)
      .agentRuns.updateExecution(run.id, { status: 'running', startedAt: run.startedAt });
  }
  // …and writes one row per model turn, step 'turn', attempt = the turn
  // number, opened running and rewritten when the turn ends (unsealed:
  // a detail without an envelope reads as it is).
  for (const turn of TURN_ROWS) {
    const id = randomUUID();
    void batch.asOf(turn.at).agentRuns.openTurn({
      id,
      runId: turn.runId,
      stepId: 'turn',
      attempt: turn.turn,
      detail: turn.detail ?? '{}',
    });
    if (turn.status === 'running') continue;
    void batch.asOf(new Date(turn.at.getTime() + 30_000)).agentRuns.writeTurn(id, {
      status: turn.status,
      toolCallCount: turn.toolCallCount,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      outcome: turn.outcome,
      detail: turn.detail ?? '{}',
      finished: true,
    });
    // The deep run's second turn staged a batch the person accepted and
    // the executor carried out.
    if (turn.runId === RUN_ITERATIONS_ID && turn.turn === 2) {
      const decided = batch.asOf(hoursAgo(4.96));
      void decided.agentRuns.stageBatch({
        id: BATCH_DEEP_ID,
        runId: RUN_ITERATIONS_ID,
        agentId: AGENT_DEEP_ID,
        ownerSubject: E2E_SUBJECT,
        turn: 2,
        status: 'proposed',
        summary: 'Escalate the VPN outage and acknowledge the laptop request.',
        actions: [
          {
            tool: 'jira_add_comment',
            args: { issueKey: 'OPS-301', body: 'Escalating to on-call — building B is down.' },
            reason: 'A building-wide outage is critical.',
          },
          {
            tool: 'jira_add_comment',
            args: { issueKey: 'OPS-302', body: 'Thanks — queued for this week.' },
            reason: 'Routine request: acknowledge it.',
          },
        ],
        reviewReason: null,
        acceptedBy: null,
        decided: false,
        waitingUntil: null,
      });
      void decided.agentRuns.settleProposedBatch(BATCH_DEEP_ID, {
        status: 'accepted',
        acceptedBy: 'person',
        decidedBy: E2E_SUBJECT,
        comment: null,
      });
      void decided.agentRuns.claimBatch(BATCH_DEEP_ID);
      void batch.asOf(hoursAgo(4.94)).agentRuns.completeBatch(BATCH_DEEP_ID, [
        {
          tool: 'jira_add_comment',
          outcome: 'succeeded',
          text: 'Comment 10041 added to OPS-301',
          durationMs: 410,
        },
        {
          tool: 'jira_add_comment',
          outcome: 'succeeded',
          text: 'Comment 10042 added to OPS-302',
          durationMs: 380,
        },
      ]);
    }
  }
  // Each run's end, as the engine records it.
  for (const run of [
    ...RUN_ROWS,
    {
      id: RUN_ITERATIONS_ID,
      status: 'succeeded',
      errorKind: null,
      error: null,
      finishedAt: hoursAgo(4.9),
      activeMs: 38_000,
    },
  ]) {
    if (run.status === 'waiting') {
      void store.agentRuns.updateExecution(run.id, {
        status: 'waiting',
        errorKind: run.errorKind,
        error: run.error,
      });
      continue;
    }
    if (!run.finishedAt) {
      void store.agentRuns.updateExecution(run.id, { activeMs: run.activeMs });
      continue;
    }
    const ended = batch.asOf(run.finishedAt);
    void ended.agentRuns.updateExecution(run.id, { activeMs: run.activeMs });
    void ended.agentRuns.finishExecution(run.id, {
      status: run.status,
      errorKind: run.errorKind,
      error: run.error,
    });
  }
}

/** The run log, the token and voice ledgers, and the tool-call log. */
function writeLedgers(batch: ReturnType<typeof dataStoreBatch>): void {
  // One run-log row per run, as the engine writes them; the first
  // `failures` of each day's runs failed.
  for (const [daysAgo, runs, failures] of SPREAD) {
    for (let n = 1; n <= runs; n += 1) {
      const runId = randomUUID();
      void batch.asOf(spreadAt(daysAgo, n)).agentRuns.logRunCreated({
        runId,
        agentId: AGENT_RICH_ID,
        ownerSubject: E2E_SUBJECT,
        triggerKind: 'schedule',
        status: 'queued',
      });
      const failed = n <= failures;
      void batch.asOf(spreadAt(daysAgo, n - 1)).agentRuns.recordOutcome({
        runId,
        agentId: AGENT_RICH_ID,
        ownerSubject: E2E_SUBJECT,
        status: failed ? 'failed' : 'succeeded',
        errorKind: failed ? 'agent_failed' : null,
        error: null,
        failed,
      });
    }
  }

  // The token ledger: the rich agent's turns on two models (two
  // prompt-cached), an optimizer pass outside any step, a row from before
  // the model was recorded, and a little on the plain agent.
  for (const [daysAgo, runs] of SPREAD) {
    for (let n = 1; n <= runs; n += 1) {
      for (const step of LEDGER_STEPS) {
        void batch.asOf(spreadAt(daysAgo, n)).usage.recordLlmCall({
          subject: E2E_SUBJECT,
          agentId: AGENT_RICH_ID,
          runId: randomUUID(),
          stepId: null,
          purpose: 'run',
          inputTokens: step.input,
          outputTokens: step.output,
          cacheReadInputTokens: step.cacheRead,
          cacheWriteInputTokens: step.cacheWrite,
          llmModelId: null,
          provider: step.provider,
          model: step.model,
          durationMs: null,
        });
      }
    }
  }
  for (const extra of [
    {
      agentId: AGENT_RICH_ID,
      purpose: 'optimize',
      model: 'claude-opus-5',
      input: 18400,
      output: 1900,
      cacheWrite: 6200,
      hours: 3,
    },
    {
      agentId: AGENT_PLAIN_ID,
      purpose: 'run',
      model: 'claude-sonnet-5',
      input: 950,
      output: 120,
      cacheWrite: 0,
      hours: 24,
    },
    {
      agentId: null,
      purpose: 'chat',
      model: 'claude-sonnet-5',
      input: 4100,
      output: 800,
      cacheWrite: 900,
      hours: 2,
    },
  ]) {
    void batch.asOf(hoursAgo(extra.hours)).usage.recordLlmCall({
      subject: E2E_SUBJECT,
      agentId: extra.agentId,
      runId: null,
      stepId: null,
      purpose: extra.purpose,
      inputTokens: extra.input,
      outputTokens: extra.output,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: extra.cacheWrite,
      llmModelId: null,
      provider: 'anthropic',
      model: extra.model,
      durationMs: null,
    });
  }

  // The voice ledger: this person is read to a lot and talks a little, the
  // colleague the reverse, so the listener and speaker boards differ.
  for (const [daysAgo, runs] of SPREAD) {
    for (let n = 1; n <= runs; n += 1) {
      for (const person of [
        { subject: E2E_SUBJECT, listen: 3, talk: 1 },
        { subject: OTHER_SUBJECT, listen: 1, talk: 4 },
      ]) {
        const at = batch.asOf(spreadAt(daysAgo, n));
        void at.usage.recordVoice({
          subject: person.subject,
          kind: 'speech',
          characters: 420 * person.listen,
          audioMs: 420 * person.listen * 65,
          provider: 'azure-speech',
          voice: 'en-GB-SoniaNeural',
          locale: 'en-GB',
        });
        void at.usage.recordVoice({
          subject: person.subject,
          kind: 'transcription',
          characters: 0,
          audioMs: 6500 * person.talk,
          provider: 'azure-speech',
          voice: null,
          locale: 'en-GB',
        });
      }
    }
  }

  // Tool calls, deliberately uneven, spread over the last three days.
  for (const row of TOOL_CALL_ROWS) {
    for (let index = 0; index < row.calls; index += 1) {
      const failed = index < row.failures;
      const startedAt = hoursAgo(1 + (index % 60));
      const durationMs = row.ms + index;
      void batch.store.toolUsage.recordCall({
        id: randomUUID(),
        subject: row.subject,
        agentId: null,
        tool: row.tool,
        connector: row.connector,
        status: failed ? 'error' : 'ok',
        startedAt,
        endedAt: new Date(startedAt.getTime() + durationMs),
        durationMs,
        errorSummary: failed ? 'The upstream API answered 500' : null,
      });
    }
  }
}

const QUEUE_CLAIM = { staleClaimMinutes: 5 } as const;

/**
 * The event monitor's rows, the way the event worker moves them: enqueued,
 * claimed, then processed, skipped, retried or dead-lettered. One call at
 * a time — each step needs the id the claim answered.
 */
async function writeEvents(request: APIRequestContext): Promise<void> {
  const rows: {
    source: string;
    type: string;
    payload: unknown;
    outcome: 'processed' | 'skipped' | 'pending' | 'dead';
    attempts: number;
    hours: number;
  }[] = [
    {
      source: 'webex',
      type: 'user-message.created',
      payload: { accountId: 'e2e-jira-account' },
      outcome: 'processed',
      attempts: 1,
      hours: 0.2,
    },
    {
      source: 'microsoft',
      type: 'change-notification',
      payload: { accountId: 'e2e-jira-account' },
      outcome: 'processed',
      attempts: 1,
      hours: 0.5,
    },
    {
      source: 'zoom',
      type: 'recording.transcript_completed',
      payload: { payload: { object: { host_email: 'guest-host@example.com' } } },
      outcome: 'skipped',
      attempts: 1,
      hours: 1,
    },
    {
      source: 'domain:webex',
      type: 'message.received',
      payload: { ownerSubject: E2E_SUBJECT, provider: 'webex' },
      outcome: 'processed',
      attempts: 1,
      hours: 0.19,
    },
    {
      source: 'microsoft',
      type: 'change-notification',
      payload: { accountId: 'e2e-jira-account' },
      outcome: 'dead',
      attempts: 5,
      hours: 3,
    },
    // Last: it stays pending, so no later claim may pick it up first.
    {
      source: 'webex',
      type: 'user-message.created',
      payload: { accountId: 'e2e-jira-account' },
      outcome: 'pending',
      attempts: 2,
      hours: 0.1,
    },
  ];
  for (const row of rows) {
    const store = dataStore(request, { at: hoursAgo(row.hours) });
    await store.queues.enqueue('events', {
      source: row.source,
      type: row.type,
      payload: row.payload,
      orderingKey: null,
    });
    for (let attempt = 1; attempt <= row.attempts; attempt += 1) {
      const claimed = await store.queues.claim('events', { ...QUEUE_CLAIM, sources: [row.source] });
      if (!claimed) throw new Error(`the ${row.source} event was not claimable`);
      const last = attempt === row.attempts;
      if (!last) {
        await store.queues.retry('events', claimed.id, 'The handler answered 503', 0);
      } else if (row.outcome === 'pending') {
        await store.queues.retry('events', claimed.id, 'The handler answered 503', 3600);
      } else if (row.outcome === 'dead') {
        await store.queues.deadLetter('events', claimed.id, 'Graph answered 503 on every attempt');
      } else {
        await store.queues.complete('events', claimed.id, row.outcome);
      }
    }
  }
}

/**
 * Write the shared fixtures, unless this server already holds them (a
 * reused dev server): then only the shared person's enrollment is
 * renewed for their session. Returns once everything is written.
 */
export async function seedSharedFixtures(request: APIRequestContext): Promise<void> {
  const store = dataStore(request);
  const seeded = (await store.agents.find(AGENT_RICH_ID)) !== null;

  // The shared person: an operator, a year-long session, enrolled with a
  // session delegation, so every page opens their chats without the
  // KeyGuard having to enroll them first. Their tours are off.
  await createPerson(request, {
    subject: E2E_SUBJECT,
    sessionId: E2E_SESSION_ID,
    displayName: 'E2E Tester',
    roles: ['renkei-user', 'renkei-operator'],
    expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000),
  });
  if (seeded) return;

  const batch = dataStoreBatch(request);
  for (const key of SANDBOX_FEATURES) void batch.store.settings.set(key, true);
  for (const connector of CONNECTORS_ON) {
    void batch.store.connectorConfigs.upsert({
      connector,
      enabled: true,
      settings: {},
      encryptedSecrets: 'not-a-real-secret',
    });
  }
  // A Jira grant, so the tool catalog enumerates Jira tools for this person
  // (it reads the scopes off the grant; nothing in e2e ever calls Jira).
  void batch.store.providerGrants.upsertSealed('atlassian', {
    accountId: 'e2e-jira-account',
    clientId: 'e2e-client',
    displayName: 'E2E Jira',
    subject: E2E_SUBJECT,
    encryptedAccessToken: 'not-a-real-token',
    encryptedRefreshToken: 'not-a-real-token',
    keepStoredRefreshToken: false,
    expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000),
    requestedScopes: JIRA_SCOPES,
    grantedScopes: null,
    metadata: {},
  });
  writeAgents(batch);
  writeLedgers(batch);
  await batch.send();
  await writeEvents(request);
}
