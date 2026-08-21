/**
 * Deterministic screenshot fixtures. Fixed UUIDs + delete-then-insert make
 * re-runs idempotent; raw SQL through `pg` keeps Playwright's globalSetup
 * free of workspace-package transpilation.
 *
 * What gets seeded and why:
 *  - a tenant (slug `e2e`) and a session row — the ONLY way to be signed in,
 *    since the cookie is an opaque id and there is no dev login route
 *    (lib/session.ts). The cookie itself is written by global-setup.ts.
 *  - two agents: one rich (description, review notes, failure handling, runs
 *    in every interesting state) and one minimal linear agent, so the builder
 *    edit page can be captured both dense and plain.
 *  - runs covering succeeded / step_failed / timeout / running, with attempt
 *    rows shaped exactly like the engine writes them (run-timeline.tsx reads
 *    detail.llmSummary / detail.toolCalls / outcome codes).
 *
 * Knowledge notes are NOT seeded: they live in knowledge_chunks, which needs
 * a pgvector embedding per row — the panel's empty state is what screenshots
 * get, which is fine.
 */

import type { Client } from 'pg';

export const E2E_TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const E2E_SLUG = 'e2e';
export const E2E_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const E2E_SUBJECT = 'e2e-user@example.com';

export const AGENT_RICH_ID = '33333333-3333-4333-8333-333333333333';
export const AGENT_PLAIN_ID = '44444444-4444-4444-8444-444444444444';

export const RUN_SUCCEEDED_ID = '66666666-6666-4666-8666-666666666661';
export const RUN_STEP_FAILED_ID = '66666666-6666-4666-8666-666666666662';
export const RUN_TIMEOUT_ID = '66666666-6666-4666-8666-666666666663';
export const RUN_RUNNING_ID = '66666666-6666-4666-8666-666666666664';

const STEP_COLLECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const STEP_RANK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const STEP_FILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const STEP_BRANCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const STEP_WRAP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
const PATH_YES = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const PATH_NO = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
export const BRANCH_YES_NAME = 'File the tickets';

const TRIGGER_RICH = '55555555-5555-4555-8555-555555555551';
const TRIGGER_PLAIN = '55555555-5555-4555-8555-555555555552';

/**
 * The rich agent's steps — a v2 doc WITH a branch, so screenshots exercise
 * the fan-out canvas, the branch editor, and the timeline's "Took path".
 * Tools are Jira tools on purpose: the Jira connector is provisioned for
 * every caller (unlike grant-gated connectors), so the builder shows this
 * agent fully valid, with the curated failure panel populated.
 *
 * Pre-order ordinals (= step_index): collect 0, rank 1, branch 2, file 3,
 * wrap 4.
 */
const RICH_STEPS = {
  version: 2,
  steps: [
    {
      id: STEP_COLLECT,
      name: 'Find yesterday’s activity',
      instruction: [
        { t: 'text', v: 'Search for issues updated yesterday with ' },
        { t: 'tool', name: 'jira_search_issues' },
        { t: 'text', v: ' and keep anything that looks like a request or a problem report.' },
      ],
      tool: 'jira_search_issues',
      maxAttempts: 2,
      saveAs: 'activity',
      failureHandling: [],
    },
    {
      id: STEP_RANK,
      name: 'Pick what is actionable',
      instruction: [
        { t: 'text', v: 'From ' },
        { t: 'var', name: 'activity' },
        { t: 'text', v: ', pick the items that need follow-up and summarize each in one line.' },
      ],
      tool: null,
      maxAttempts: 1,
      saveAs: 'actionable',
      failureHandling: [],
    },
    {
      id: STEP_BRANCH,
      kind: 'branch',
      name: 'Anything actionable?',
      condition: [
        { t: 'text', v: 'Did ' },
        { t: 'var', name: 'actionable' },
        { t: 'text', v: ' turn up at least one item that needs follow-up?' },
      ],
      paths: [
        {
          id: PATH_YES,
          name: BRANCH_YES_NAME,
          steps: [
            {
              id: STEP_FILE,
              name: 'File follow-up tickets',
              instruction: [
                { t: 'text', v: 'Create one issue per item in ' },
                { t: 'var', name: 'actionable' },
                { t: 'text', v: ' using ' },
                { t: 'tool', name: 'jira_create_issue' },
                { t: 'text', v: ' in the OPS project.' },
              ],
              tool: 'jira_create_issue',
              maxAttempts: 3,
              failureHandling: [
                {
                  outcome: 'project-not-found',
                  action: 'retry',
                  guidance: [{ t: 'text', v: 'List the projects first and use the closest key.' }],
                },
              ],
            },
          ],
        },
        { id: PATH_NO, name: 'Quiet day', steps: [] },
      ],
      maxAttempts: 2,
    },
    {
      id: STEP_WRAP,
      name: 'Note the outcome',
      instruction: [
        { t: 'text', v: 'Write one line summarizing what was filed (or that nothing was needed).' },
      ],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
  ],
};

const PLAIN_STEPS = {
  version: 1,
  steps: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      name: 'Summarize yesterday',
      instruction: [{ t: 'text', v: 'Write a three-line summary of yesterday’s activity.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
  ],
};

const REVIEW_NOTES = [
  {
    issue: 'Step 3 files tickets without asking which project when OPS is ambiguous.',
    fix: 'Name the project explicitly in the instruction, or save a project key in an earlier step.',
  },
];

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

/** Engine-shaped attempt detail — keys match run-timeline.tsx's reader. */
function attemptDetail(input: {
  resolvedInstruction: string;
  llmSummary: string;
  toolCalls?: {
    tool: string;
    argsPreview: string;
    resultPreview: string;
    durationMs: number;
    isError?: boolean;
  }[];
  saveValue?: string;
  chosenPathId?: string;
  chosenPathName?: string;
}): string {
  return JSON.stringify(input);
}

export async function seed(client: Client): Promise<void> {
  // Delete in FK-dependency order, then insert fresh.
  await client.query('DELETE FROM events WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM events_dead_letters WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM agent_run_steps WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM agent_runs WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM agent_memories WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM agent_triggers WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM agents WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM provider_grants WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM sessions WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM identities WHERE tenant_id = $1', [E2E_TENANT_ID]);
  await client.query('DELETE FROM tenants WHERE id = $1', [E2E_TENANT_ID]);

  await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [E2E_TENANT_ID, E2E_SLUG]);

  await client.query(
    `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      E2E_SESSION_ID,
      E2E_TENANT_ID,
      E2E_SUBJECT,
      ['renkei-user', 'renkei-operator'],
      new Date(Date.now() + 365 * 24 * 3_600_000),
    ]
  );

  await client.query(
    `INSERT INTO identities (tenant_id, subject, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [E2E_TENANT_ID, E2E_SUBJECT, E2E_SUBJECT, 'E2E Tester']
  );

  // A Jira grant row so the tool catalog enumerates Jira tools for this user
  // (the catalog reads scopes straight off the row and never touches the
  // tokens, so dummies are fine — nothing in e2e ever calls Jira). Granular
  // scopes, not the classic pair: the tools gate on the granular catalog.
  await client.query(
    `INSERT INTO provider_grants
       (tenant_id, provider, provider_account_id, subject, client_id, display_name,
        encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes)
     VALUES ($1, 'atlassian', 'e2e-jira-account', $2, 'e2e-client', 'E2E Jira',
             'not-a-real-token', 'not-a-real-token', $3, $4)
     ON CONFLICT DO NOTHING`,
    [
      E2E_TENANT_ID,
      E2E_SUBJECT,
      new Date(Date.now() + 365 * 24 * 3_600_000),
      [
        'read:issue:jira',
        'write:issue:jira',
        'read:user:jira',
        'read:project:jira',
        'read:jql:jira',
        'read:field:jira',
        'read:comment:jira',
        'write:comment:jira',
        'read:board-scope:jira-software',
      ],
    ]
  );

  await client.query(
    `INSERT INTO agents
       (id, tenant_id, owner_subject, name, description, description_status,
        review_notes, steps, enabled)
     VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, true)`,
    [
      AGENT_RICH_ID,
      E2E_TENANT_ID,
      E2E_SUBJECT,
      'Triage yesterday into tickets',
      'Every weekday morning this agent reviews yesterday’s Jira activity, picks out what needs follow-up, and files a ticket for each item in the OPS project.',
      JSON.stringify(REVIEW_NOTES),
      JSON.stringify(RICH_STEPS),
    ]
  );

  await client.query(
    `INSERT INTO agents
       (id, tenant_id, owner_subject, name, description, description_status, steps, enabled)
     VALUES ($1, $2, $3, $4, $5, 'ready', $6, false)`,
    [
      AGENT_PLAIN_ID,
      E2E_TENANT_ID,
      E2E_SUBJECT,
      'Daily activity digest',
      'Writes a short summary of the previous day.',
      JSON.stringify(PLAIN_STEPS),
    ]
  );

  const scheduleConfig = JSON.stringify({
    recurrences: [{ every: 'weekday', at: '09:00' }],
    timezone: 'UTC',
  });
  await client.query(
    `INSERT INTO agent_triggers (id, tenant_id, agent_id, kind, config, enabled, next_run_at)
     VALUES ($1, $2, $3, 'schedule', $4, true, $5)`,
    [TRIGGER_RICH, E2E_TENANT_ID, AGENT_RICH_ID, scheduleConfig, hoursAgo(-20)]
  );
  await client.query(
    `INSERT INTO agent_triggers (id, tenant_id, agent_id, kind, config, enabled)
     VALUES ($1, $2, $3, 'schedule', $4, false)`,
    [TRIGGER_PLAIN, E2E_TENANT_ID, AGENT_PLAIN_ID, scheduleConfig]
  );

  await client.query(
    `INSERT INTO agent_memories (id, tenant_id, agent_id, kind, content)
     VALUES ($1, $2, $3, 'summary', $4),
            ($5, $2, $3, 'entry', $6),
            ($7, $2, $3, 'entry', $8)`,
    [
      '77777777-7777-4777-8777-777777777771',
      E2E_TENANT_ID,
      AGENT_RICH_ID,
      'The OPS project is the right home for infrastructure requests; HR questions go to the PEOPLE desk instead.',
      '77777777-7777-4777-8777-777777777772',
      'Filed OPS-231 for the VPN outage thread; sender confirmed it covered their ask.',
      '77777777-7777-4777-8777-777777777773',
      'Skipped the newsletter digest — recurring, never actionable.',
    ]
  );

  const snapshot = JSON.stringify(RICH_STEPS);
  const runRows: [
    string,
    string,
    string | null,
    string | null,
    string | null,
    Date | null,
    Date | null,
  ][] = [
    // id, status, error_kind, error, current_step_id, started_at, finished_at
    [RUN_SUCCEEDED_ID, 'succeeded', null, null, STEP_FILE, hoursAgo(26), hoursAgo(25.9)],
    [
      RUN_STEP_FAILED_ID,
      'failed',
      'step_failed',
      'Step "File follow-up tickets" failed after 2 attempt(s) (other).',
      STEP_FILE,
      hoursAgo(2),
      hoursAgo(1.9),
    ],
    [
      RUN_TIMEOUT_ID,
      'failed',
      'timeout',
      'The run exceeded the time limit.',
      STEP_RANK,
      hoursAgo(50),
      hoursAgo(49),
    ],
    [RUN_RUNNING_ID, 'running', null, null, STEP_COLLECT, hoursAgo(0.05), null],
  ];
  for (const [id, status, errorKind, error, currentStep, startedAt, finishedAt] of runRows) {
    await client.query(
      `INSERT INTO agent_runs
         (id, tenant_id, agent_id, owner_subject, trigger_kind, trigger_id,
          steps_snapshot, status, error_kind, error, current_step_id,
          started_at, finished_at, created_at)
       VALUES ($1, $2, $3, $4, 'schedule', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        E2E_TENANT_ID,
        AGENT_RICH_ID,
        E2E_SUBJECT,
        TRIGGER_RICH,
        snapshot,
        status,
        errorKind,
        error,
        currentStep,
        startedAt,
        finishedAt,
        startedAt ?? new Date(),
      ]
    );
  }

  // Attempt rows. UNIQUE (run_id, step_id, attempt) — one insert per row.
  const stepRows: {
    id: string;
    runId: string;
    stepId: string;
    stepIndex: number;
    attempt: number;
    status: string;
    outcome: string | null;
    outcomeCode: string | null;
    toolCallCount: number;
    detail: string | null;
    at: Date;
  }[] = [
    {
      id: '88888888-8888-4888-8888-888888888801',
      runId: RUN_SUCCEEDED_ID,
      stepId: STEP_COLLECT,
      stepIndex: 0,
      attempt: 1,
      status: 'succeeded',
      outcome: 'tool_ok',
      outcomeCode: null,
      toolCallCount: 1,
      detail: attemptDetail({
        resolvedInstruction: 'Search for issues updated yesterday…',
        llmSummary: 'Found 6 activity items; 3 look actionable.',
        toolCalls: [
          {
            tool: 'jira_search_issues',
            argsPreview: '{"jql":"updated >= -1d order by updated"}',
            resultPreview: '6 items (VPN outage, printer, onboarding…)',
            durationMs: 812,
          },
        ],
        saveValue: '6 messages, 3 actionable',
      }),
      at: hoursAgo(26),
    },
    {
      id: '88888888-8888-4888-8888-888888888802',
      runId: RUN_SUCCEEDED_ID,
      stepId: STEP_RANK,
      stepIndex: 1,
      attempt: 1,
      status: 'succeeded',
      outcome: 'llm_declared',
      outcomeCode: null,
      toolCallCount: 0,
      detail: attemptDetail({
        resolvedInstruction: 'From (activity), pick the items that need follow-up…',
        llmSummary: 'Kept the VPN outage and the two access requests.',
        saveValue: '3 items',
      }),
      at: hoursAgo(25.95),
    },
    {
      id: '88888888-8888-4888-8888-888888888806',
      runId: RUN_SUCCEEDED_ID,
      stepId: STEP_BRANCH,
      stepIndex: 2,
      attempt: 1,
      status: 'succeeded',
      outcome: 'path_chosen',
      outcomeCode: null,
      toolCallCount: 0,
      detail: attemptDetail({
        resolvedInstruction: 'Did (actionable) turn up at least one item that needs follow-up?',
        llmSummary: 'Three actionable items were listed, so the filing path applies.',
        chosenPathId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        chosenPathName: BRANCH_YES_NAME,
      }),
      at: hoursAgo(25.94),
    },
    {
      id: '88888888-8888-4888-8888-888888888803',
      runId: RUN_SUCCEEDED_ID,
      stepId: STEP_FILE,
      stepIndex: 3,
      attempt: 1,
      status: 'succeeded',
      outcome: 'tool_ok',
      outcomeCode: null,
      toolCallCount: 3,
      detail: attemptDetail({
        resolvedInstruction: 'Create one issue per item…',
        llmSummary: 'Filed OPS-231, OPS-232, OPS-233.',
        toolCalls: [
          {
            tool: 'jira_create_issue',
            argsPreview: '{"project":"OPS","summary":"VPN outage — building B"}',
            resultPreview: 'Note saved',
            durationMs: 640,
          },
          {
            tool: 'jira_create_issue',
            argsPreview: '{"project":"OPS","summary":"Access request: analytics DB"}',
            resultPreview: 'Note saved',
            durationMs: 587,
          },
          {
            tool: 'jira_create_issue',
            argsPreview: '{"project":"OPS","summary":"Access request: staging VPN"}',
            resultPreview: 'Note saved',
            durationMs: 559,
          },
        ],
      }),
      at: hoursAgo(25.92),
    },
    {
      id: '88888888-8888-4888-8888-888888888807',
      runId: RUN_SUCCEEDED_ID,
      stepId: STEP_WRAP,
      stepIndex: 4,
      attempt: 1,
      status: 'succeeded',
      outcome: 'llm_declared',
      outcomeCode: null,
      toolCallCount: 0,
      detail: attemptDetail({
        resolvedInstruction: 'Write one line summarizing what was filed…',
        llmSummary: 'Filed OPS-231, OPS-232, OPS-233 for yesterday’s three requests.',
      }),
      at: hoursAgo(25.9),
    },
    {
      id: '88888888-8888-4888-8888-888888888811',
      runId: RUN_STEP_FAILED_ID,
      stepId: STEP_COLLECT,
      stepIndex: 0,
      attempt: 1,
      status: 'succeeded',
      outcome: 'tool_ok',
      outcomeCode: null,
      toolCallCount: 1,
      detail: attemptDetail({
        resolvedInstruction: 'Search for issues updated yesterday…',
        llmSummary: 'Found 2 activity items; 1 looks actionable.',
        toolCalls: [
          {
            tool: 'jira_search_issues',
            argsPreview: '{"jql":"updated >= -1d order by updated"}',
            resultPreview: '2 items',
            durationMs: 700,
          },
        ],
      }),
      at: hoursAgo(2),
    },
    {
      id: '88888888-8888-4888-8888-888888888812',
      runId: RUN_STEP_FAILED_ID,
      stepId: STEP_RANK,
      stepIndex: 1,
      attempt: 1,
      status: 'succeeded',
      outcome: 'llm_declared',
      outcomeCode: null,
      toolCallCount: 0,
      detail: attemptDetail({
        resolvedInstruction: 'From (activity), pick the items that need follow-up…',
        llmSummary: 'One actionable item: expired certificate on the intranet.',
      }),
      at: hoursAgo(1.98),
    },
    {
      id: '88888888-8888-4888-8888-888888888815',
      runId: RUN_STEP_FAILED_ID,
      stepId: STEP_BRANCH,
      stepIndex: 2,
      attempt: 1,
      status: 'succeeded',
      outcome: 'path_chosen',
      outcomeCode: null,
      toolCallCount: 0,
      detail: attemptDetail({
        resolvedInstruction: 'Did (actionable) turn up at least one item that needs follow-up?',
        llmSummary: 'One actionable item was listed.',
        chosenPathId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        chosenPathName: BRANCH_YES_NAME,
      }),
      at: hoursAgo(1.97),
    },
    {
      id: '88888888-8888-4888-8888-888888888813',
      runId: RUN_STEP_FAILED_ID,
      stepId: STEP_FILE,
      stepIndex: 3,
      attempt: 1,
      status: 'failed',
      outcome: 'tool_error',
      outcomeCode: 'project-not-found',
      toolCallCount: 1,
      detail: attemptDetail({
        resolvedInstruction: 'Create one issue per item…',
        llmSummary: 'Jira rejected the project key.',
        toolCalls: [
          {
            tool: 'jira_create_issue',
            argsPreview: '{"project":"OPS","summary":"Expired intranet certificate"}',
            resultPreview: 'No project matches the key OPS.',
            durationMs: 431,
            isError: true,
          },
        ],
      }),
      at: hoursAgo(1.95),
    },
    {
      id: '88888888-8888-4888-8888-888888888814',
      runId: RUN_STEP_FAILED_ID,
      stepId: STEP_FILE,
      stepIndex: 3,
      attempt: 2,
      status: 'failed',
      outcome: 'tool_error',
      outcomeCode: 'other',
      toolCallCount: 1,
      detail: attemptDetail({
        resolvedInstruction: 'Create one issue per item…',
        llmSummary: 'Retry against OPSX also failed — permissions.',
        toolCalls: [
          {
            tool: 'jira_create_issue',
            argsPreview: '{"project":"OPSX","summary":"Expired intranet certificate"}',
            resultPreview: 'The note content was not accepted.',
            durationMs: 512,
            isError: true,
          },
        ],
      }),
      at: hoursAgo(1.92),
    },
    {
      id: '88888888-8888-4888-8888-888888888821',
      runId: RUN_TIMEOUT_ID,
      stepId: STEP_COLLECT,
      stepIndex: 0,
      attempt: 1,
      status: 'succeeded',
      outcome: 'tool_ok',
      outcomeCode: null,
      toolCallCount: 1,
      detail: attemptDetail({
        resolvedInstruction: 'Search for issues updated yesterday…',
        llmSummary: 'Found 41 activity items.',
      }),
      at: hoursAgo(50),
    },
    {
      id: '88888888-8888-4888-8888-888888888831',
      runId: RUN_RUNNING_ID,
      stepId: STEP_COLLECT,
      stepIndex: 0,
      attempt: 1,
      status: 'running',
      outcome: null,
      outcomeCode: null,
      toolCallCount: 0,
      detail: null,
      at: hoursAgo(0.05),
    },
  ];

  for (const row of stepRows) {
    await client.query(
      `INSERT INTO agent_run_steps
         (id, tenant_id, run_id, step_id, step_index, attempt, status,
          outcome, outcome_code, tool_call_count, detail, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.id,
        E2E_TENANT_ID,
        row.runId,
        row.stepId,
        row.stepIndex,
        row.attempt,
        row.status,
        row.outcome,
        row.outcomeCode,
        row.toolCallCount,
        row.detail,
        row.at,
        row.status === 'running' ? null : new Date(row.at.getTime() + 30_000),
      ]
    );
  }

  // The admin event monitor: one row per status it can render (the deletes
  // live in the FK-ordered block at the top — events reference the tenant).
  // The webex/microsoft rows reuse the Jira grant's account id on purpose —
  // the page resolves owners via provider_grants by account id alone, so
  // they display as the seeded user's email.
  const eventRows = [
    {
      source: 'webex',
      type: 'user-message.created',
      payload: { accountId: 'e2e-jira-account' },
      status: 'processed',
      attempts: 1,
      at: hoursAgo(0.2),
    },
    {
      source: 'microsoft',
      type: 'change-notification',
      payload: { accountId: 'e2e-jira-account' },
      status: 'processed',
      attempts: 1,
      at: hoursAgo(0.5),
    },
    {
      source: 'zoom',
      type: 'recording.transcript_completed',
      payload: { payload: { object: { host_email: 'guest-host@example.com' } } },
      status: 'skipped',
      attempts: 1,
      at: hoursAgo(1),
    },
    {
      source: 'domain:webex',
      type: 'message.received',
      payload: { ownerSubject: E2E_SUBJECT, provider: 'webex' },
      status: 'processed',
      attempts: 1,
      at: hoursAgo(0.19),
    },
    {
      source: 'webex',
      type: 'user-message.created',
      payload: { accountId: 'e2e-jira-account' },
      status: 'pending',
      attempts: 2,
      at: hoursAgo(0.1),
    },
  ];
  for (const row of eventRows) {
    await client.query(
      `INSERT INTO events (id, tenant_id, source, type, payload, status, attempts, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $7)`,
      [
        E2E_TENANT_ID,
        row.source,
        row.type,
        JSON.stringify(row.payload),
        row.status,
        row.attempts,
        row.at,
      ]
    );
  }
  await client.query(
    `INSERT INTO events_dead_letters
       (id, tenant_id, source, type, payload, attempts, last_error, created_at)
     VALUES (gen_random_uuid(), $1, 'microsoft', 'change-notification', $2, 5,
             'Graph answered 503 on every attempt', $3)`,
    [E2E_TENANT_ID, JSON.stringify({ accountId: 'e2e-jira-account' }), hoursAgo(3)]
  );

  // Run tallies for the overview's Invocations panel: today, earlier this
  // week/month/year — enough spread that every bucket shows a distinct
  // number. (Cleanup rides the tenant delete's cascade.)
  await client.query(
    `INSERT INTO agent_run_counters (tenant_id, agent_id, day, runs, failures) VALUES
       ($1, $2, CURRENT_DATE, 3, 1),
       ($1, $2, CURRENT_DATE - 2, 4, 0),
       ($1, $2, CURRENT_DATE - 12, 6, 2),
       ($1, $2, CURRENT_DATE - 70, 9, 0),
       ($1, $2, CURRENT_DATE - 320, 20, 5)
     ON CONFLICT (tenant_id, agent_id, day)
     DO UPDATE SET runs = EXCLUDED.runs, failures = EXCLUDED.failures`,
    [E2E_TENANT_ID, AGENT_RICH_ID]
  );
}
