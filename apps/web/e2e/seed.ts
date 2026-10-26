/**
 * Deterministic screenshot fixtures. Fixed UUIDs + delete-then-insert make
 * re-runs idempotent; raw SQL through `pg` keeps Playwright's globalSetup
 * free of workspace-package transpilation.
 *
 * What gets seeded and why:
 *  - a tenant (slug `e2e`) and a session row — the ONLY way to be signed in,
 *    since the cookie is an opaque id and there is no dev login route
 *    (lib/session.ts). The cookie itself is written by global-setup.ts.
 *  - three agents: one rich (description, review notes, full structured
 *    instructions, runs in every interesting state), one minimal, and one
 *    whose run staged a batch of changes the executor carried out.
 *  - runs covering succeeded / failed / timeout / running / parked, with
 *    turn rows and a staged batch shaped exactly like the engine writes them
 *    (run-timeline.tsx reads detail.llmSummary / toolCalls / finish).
 *
 * Knowledge notes are NOT seeded: they live in knowledge_chunks, which needs
 * a pgvector embedding per row — the panel's empty state is what screenshots
 * get, which is fine.
 */

import type { Client } from 'pg';
import { enrollForE2E } from './keys';

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

const TRIGGER_RICH = '55555555-5555-4555-8555-555555555551';
const TRIGGER_PLAIN = '55555555-5555-4555-8555-555555555552';

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

/**
 * The column that names a person on each table a spec seeds for itself.
 * Specs run concurrently against one database, so a spec clears only ITS
 * person's rows before seeding; a table missing here holds organization-wide
 * rows (settings, connector configs, model configs, OAuth clients) that no
 * subject owns, and is cleared whole — a spec that writes one of those
 * shares it with every other spec in the run.
 */
const SUBJECT_COLUMN: Record<string, string> = {
  agent_notifications: 'subject',
  agent_runs: 'owner_subject',
  agents: 'owner_subject',
  audit_events: 'actor_subject',
  artifact_references: 'added_by',
  artifacts: 'owner_subject',
  chat_projects: 'owner_subject',
  chats: 'owner_subject',
  document_usage: 'subject',
  identities: 'subject',
  image_usage: 'subject',
  jira_admin_change_requests: 'subject',
  jira_admin_space_templates: 'created_by',
  oauth_access_tokens: 'subject',
  oauth_authorization_codes: 'subject',
  oauth_consent_requests: 'subject',
  oauth_refresh_tokens: 'subject',
  provider_grants: 'subject',
  sandbox_size_requests: 'subject',
  sessions: 'subject',
  user_encryption_keys: 'subject',
  user_preferences: 'subject',
};

/** Clear a spec's own rows (the subjects it seeds) from `tables`, in the order given. */
export async function deleteRowsOf(
  client: Client,
  subjects: string | readonly string[],
  tables: readonly string[]
): Promise<void> {
  const owners = typeof subjects === 'string' ? [subjects] : [...subjects];
  for (const table of tables) {
    const column = SUBJECT_COLUMN[table];
    if (column) await client.query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [owners]);
    else await client.query(`DELETE FROM ${table}`);
  }
}

export async function seed(client: Client): Promise<void> {
  // Delete in FK-dependency order, then insert fresh.
  await client.query('DELETE FROM events');
  await client.query('DELETE FROM events_dead_letters');
  await client.query('DELETE FROM agent_run_steps');
  await client.query('DELETE FROM agent_runs');
  await client.query('DELETE FROM agent_memories');
  await client.query('DELETE FROM agent_triggers');
  await client.query('DELETE FROM agents');
  await client.query('DELETE FROM tool_calls');
  await client.query('DELETE FROM connector_configs');
  // Chats pin a model, and a model row does not cascade from its tenant:
  // a chat spec's fixtures from an earlier run would otherwise block the
  // tenant's re-creation here.
  await client.query('DELETE FROM chats');
  await client.query('DELETE FROM llm_model_configs');
  await client.query('DELETE FROM provider_grants');
  await client.query('DELETE FROM sessions');
  await client.query('DELETE FROM identities');
  // A chat turn that actually ran (widget-card.spec.ts) minted a run
  // token, and that registers one synthetic OAuth client per tenant
  // (packages/mcp-client/src/token.ts) — a row that does not cascade from
  // the tenant, so an earlier run's would block the re-creation here.
  await client.query('DELETE FROM oauth_access_tokens');
  // Refresh tokens are the clients' children: a run's own (oauth-consent) would block their delete.
  await client.query('DELETE FROM oauth_refresh_tokens');
  await client.query('DELETE FROM oauth_clients');
  // Org settings do not cascade from the tenant: migration 151 writes one row
  // (the registration default) for every tenant that exists when it runs,
  // and the rows below put more there.
  await client.query('DELETE FROM settings');
  // Verified at creation: the sign-in page routes a domain only to a tenant
  // whose domain_verified_at is set (migration 146), and nothing in e2e
  // publishes DNS records.
  // The sandbox features the Code pages, charts and browser specs drive,
  // as the organization's own settings (migration 152 moved them out of
  // SANDBOX_*_ENABLED): workspaces and services for the code specs, the
  // browser and charts for the chat ones; scripts stay off.
  for (const key of [
    'sandbox_browser_enabled',
    'sandbox_charts_enabled',
    'sandbox_workspaces_enabled',
    'sandbox_services_enabled',
  ]) {
    await client.query(`INSERT INTO settings (key, value) VALUES ($1, 'true'::jsonb)`, [key]);
  }

  await client.query(
    `INSERT INTO sessions (id, subject, roles, expires_at)\n     VALUES ($1, $2, $3, $4)`,
    [
      E2E_SESSION_ID,
      E2E_SUBJECT,
      ['renkei-user', 'renkei-operator'],
      new Date(Date.now() + 365 * 24 * 3_600_000),
    ]
  );

  await client.query(
    `INSERT INTO identities (subject, email, display_name)\n     VALUES ($1, $2, $3)`,
    [E2E_SUBJECT, E2E_SUBJECT, 'E2E Tester']
  );

  // The person holds their own encryption key (docs/delegate-key-design.md):
  // enrolled here the way their browser would be, with a session delegation
  // to the running delegate, so every page opens their chats without the
  // KeyGuard having to enroll them first.
  await enrollForE2E(client, E2E_SUBJECT);

  // The coach marks stay out of every other spec's way: this person has
  // tours switched off, so no card lands on a page a screenshot is about
  // to capture. coach-marks.spec.ts signs in as a subject of its own.
  await client.query(
    `INSERT INTO user_preferences (subject, key, value)\n     VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)\n     ON CONFLICT (subject, key) DO UPDATE SET value = EXCLUDED.value`,
    [E2E_SUBJECT]
  );

  // A Jira grant row so the tool catalog enumerates Jira tools for this user
  // (the catalog reads scopes straight off the row and never touches the
  // tokens, so dummies are fine — nothing in e2e ever calls Jira). Granular
  // scopes, not the classic pair: the tools gate on the granular catalog.
  await client.query(
    `INSERT INTO provider_grants\n       (provider, provider_account_id, subject, client_id, display_name,\n        encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes)\n     VALUES ('atlassian', 'e2e-jira-account', $1, 'e2e-client', 'E2E Jira',\n             'not-a-real-token', 'not-a-real-token', $2, $3)\n     ON CONFLICT DO NOTHING`,
    [
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
    `INSERT INTO agents\n       (id, owner_subject, name, description, description_status,\n        review_notes, instructions, tools, enabled)\n     VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7, true)`,
    [
      AGENT_RICH_ID,
      E2E_SUBJECT,
      'Triage yesterday into tickets',
      'Every weekday morning this agent reviews yesterday’s Jira activity, picks out what needs follow-up, and files a ticket for each item in the OPS project.',
      JSON.stringify(REVIEW_NOTES),
      RICH_INSTRUCTIONS,
      JSON.stringify(RICH_TOOLS),
    ]
  );

  await client.query(
    `INSERT INTO agents\n       (id, owner_subject, name, description, description_status, instructions, tools, enabled)\n     VALUES ($1, $2, $3, $4, 'ready', $5, '[]'::jsonb, false)`,
    [
      AGENT_PLAIN_ID,
      E2E_SUBJECT,
      'Daily activity digest',
      'Writes a short summary of the previous day.',
      PLAIN_INSTRUCTIONS,
    ]
  );

  await client.query(
    `INSERT INTO agents\n       (id, owner_subject, name, description, description_status, instructions, tools, enabled)\n     VALUES ($1, $2, $3, $4, 'ready', $5, $6, false)`,
    [
      AGENT_DEEP_ID,
      E2E_SUBJECT,
      'Sweep the request queue',
      'Goes through every open request, escalates the critical ones, acknowledges the routine ones, and writes a note per request.',
      DEEP_INSTRUCTIONS,
      JSON.stringify(DEEP_TOOLS),
    ]
  );

  const scheduleConfig = JSON.stringify({
    recurrences: [{ every: 'weekday', at: '09:00' }],
    timezone: 'UTC',
  });
  await client.query(
    `INSERT INTO agent_triggers (id, agent_id, kind, config, enabled, next_run_at)\n     VALUES ($1, $2, 'schedule', $3, true, $4)`,
    [TRIGGER_RICH, AGENT_RICH_ID, scheduleConfig, hoursAgo(-20)]
  );
  await client.query(
    `INSERT INTO agent_triggers (id, agent_id, kind, config, enabled)\n     VALUES ($1, $2, 'schedule', $3, false)`,
    [TRIGGER_PLAIN, AGENT_PLAIN_ID, scheduleConfig]
  );

  await client.query(
    `INSERT INTO agent_memories (id, agent_id, kind, content)\n     VALUES ($1, $2, 'summary', $3),\n            ($4, $2, 'entry', $5),\n            ($6, $2, 'entry', $7)`,
    [
      '77777777-7777-4777-8777-777777777771',
      AGENT_RICH_ID,
      'The OPS project is the right home for infrastructure requests; HR questions go to the PEOPLE desk instead.',
      '77777777-7777-4777-8777-777777777772',
      'Filed OPS-231 for the VPN outage thread; sender confirmed it covered their ask.',
      '77777777-7777-4777-8777-777777777773',
      'Skipped the newsletter digest — recurring, never actionable.',
    ]
  );

  const snapshot = JSON.stringify({ instructions: RICH_INSTRUCTIONS, tools: RICH_TOOLS });
  const runRows: [
    string,
    string,
    string | null,
    string | null,
    Date | null,
    Date | null,
    number,
  ][] = [
    // id, status, error_kind, error, started_at, finished_at, active_ms
    [RUN_SUCCEEDED_ID, 'succeeded', null, null, hoursAgo(26), hoursAgo(25.9), 41_000],
    [
      RUN_STEP_FAILED_ID,
      'failed',
      'agent_failed',
      'Could not file the follow-up: the OPS project rejected the issue type “Task”.',
      hoursAgo(2),
      hoursAgo(1.9),
      52_000,
    ],
    [
      RUN_TIMEOUT_ID,
      'failed',
      'timeout',
      'The run used its 30 minutes of active time.',
      hoursAgo(50),
      hoursAgo(49),
      1_800_000,
    ],
    [RUN_RUNNING_ID, 'running', null, null, hoursAgo(0.05), null, 3_000],
    // Parked by the engine: the owner's key was not delegated when the
    // schedule fired (docs/delegate-key-design.md, phase 3). Their next
    // sign-in re-queues it; until then the list says so.
    [
      RUN_PARKED_ID,
      'waiting',
      'needs-sign-in',
      'Paused: your encryption key is not available to your agents. Sign in to resume.',
      null,
      null,
      0,
    ],
  ];
  for (const [id, status, errorKind, error, startedAt, finishedAt, activeMs] of runRows) {
    await client.query(
      `INSERT INTO agent_runs\n         (id, agent_id, owner_subject, trigger_kind, trigger_id,\n          definition_snapshot, status, error_kind, error,\n          started_at, finished_at, created_at, active_ms)\n       VALUES ($1, $2, $3, 'schedule', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        AGENT_RICH_ID,
        E2E_SUBJECT,
        TRIGGER_RICH,
        snapshot,
        status,
        errorKind,
        error,
        startedAt,
        finishedAt,
        startedAt ?? new Date(),
        activeMs,
      ]
    );
  }

  // The deep agent's run: reads, then one staged batch the executor
  // carried out — the timeline's batch rendering.
  await client.query(
    `INSERT INTO agent_runs\n       (id, agent_id, owner_subject, trigger_kind, definition_snapshot,\n        status, started_at, finished_at, created_at, active_ms)\n     VALUES ($1, $2, $3, 'manual', $4, 'succeeded', $5, $6, $5, 38000)`,
    [
      RUN_ITERATIONS_ID,
      AGENT_DEEP_ID,
      E2E_SUBJECT,
      JSON.stringify({ instructions: DEEP_INSTRUCTIONS, tools: DEEP_TOOLS }),
      hoursAgo(5),
      hoursAgo(4.9),
    ]
  );

  // Turn rows — one per model turn, step_id 'turn', attempt = the turn
  // number, exactly as the engine writes them (unsealed here: a row
  // without an envelope reads as it is).
  const model = (ms: number) => [
    { durationMs: ms, stopReason: 'tool_use', inputTokens: 900, outputTokens: 60 },
  ];
  const turnRows: {
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
  for (const row of turnRows) {
    await client.query(
      `INSERT INTO agent_run_steps\n         (id, run_id, step_id, step_index, attempt, iteration, status,\n          outcome, tool_call_count, detail, started_at, finished_at)\n       VALUES (gen_random_uuid(), $1, 'turn', $2, $2, 0, $3, $4, $5, $6, $7, $8)`,
      [
        row.runId,
        row.turn,
        row.status,
        row.outcome,
        row.toolCallCount,
        row.detail,
        row.at,
        row.status === 'running' ? null : new Date(row.at.getTime() + 30_000),
      ]
    );
  }
  await client.query(
    `INSERT INTO agent_action_batches\n       (id, run_id, agent_id, owner_subject, turn, status, summary, actions, results,\n        accepted_by, decided_by, decided_at, created_at, finished_at)\n     VALUES ($1, $2, $3, $4, 2, 'completed', $5, $6, $7, 'person', $4, $8, $8, $9)`,
    [
      BATCH_DEEP_ID,
      RUN_ITERATIONS_ID,
      AGENT_DEEP_ID,
      E2E_SUBJECT,
      'Escalate the VPN outage and acknowledge the laptop request.',
      JSON.stringify([
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
      ]),
      JSON.stringify([
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
      ]),
      hoursAgo(4.96),
      hoursAgo(4.94),
    ]
  );

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
      `INSERT INTO events (id, source, type, payload, status, attempts, created_at, updated_at)\n       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $6)`,
      [row.source, row.type, JSON.stringify(row.payload), row.status, row.attempts, row.at]
    );
  }
  await client.query(
    `INSERT INTO events_dead_letters\n       (id, source, type, payload, attempts, last_error, created_at)\n     VALUES (gen_random_uuid(), 'microsoft', 'change-notification', $1, 5,\n             'Graph answered 503 on every attempt', $2)`,
    [JSON.stringify({ accountId: 'e2e-jira-account' }), hoursAgo(3)]
  );

  // Run-log rows for the overview's Invocations panel: today, earlier this
  // week/month/year — enough spread that every bucket shows a distinct
  // number. One row per run, as the engine writes them; the first
  // `failures` of each day's runs are failed. (Cleanup rides the tenant
  // delete's cascade.)
  await client.query(
    `INSERT INTO agent_run_log (run_id, agent_id, owner_subject, trigger_kind, status, created_at, finished_at)\n     SELECT gen_random_uuid(), $1, (SELECT owner_subject FROM agents WHERE id = $1), 'schedule',\n            CASE WHEN n <= spread.failures THEN 'failed' ELSE 'succeeded' END,\n            NOW() - make_interval(days => spread.days_ago, mins => n),\n            NOW() - make_interval(days => spread.days_ago, mins => n - 1)\n     FROM (VALUES (0, 3, 1), (1, 2, 1), (2, 4, 0), (12, 6, 2), (70, 9, 0), (320, 20, 5))\n       AS spread(days_ago, runs, failures)\n     CROSS JOIN LATERAL generate_series(1, spread.runs) AS n`,
    [AGENT_RICH_ID]
  );

  // Token-ledger rows behind the oversight columns and the agent page's
  // by-model table: the rich agent's turns on two models with
  // two prompt-cached (cached is a PORTION of input), an optimizer pass outside any step, a row from
  // before the model was recorded, and a little on the plain agent so the
  // oversight sort has something to order. Same day spread as the run log.
  await client.query(
    `INSERT INTO llm_calls\n       (subject, agent_id, run_id, purpose, provider, model,\n        input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens, created_at)\n     SELECT $2, $1, gen_random_uuid(), 'run', step.provider, step.model,\n            step.input_tokens, step.output_tokens, step.cache_read, step.cache_write,\n            NOW() - make_interval(days => spread.days_ago, mins => n)\n     FROM (VALUES (0, 3), (1, 2), (2, 4), (12, 6), (70, 9), (320, 20)) AS spread(days_ago, runs)\n     CROSS JOIN LATERAL generate_series(1, spread.runs) AS n\n     CROSS JOIN (VALUES\n       ('anthropic', 'claude-sonnet-5', 3580, 210, 2400, 0),\n       ('anthropic', 'claude-opus-5', 3650, 640, 0, 0),\n       ('openai', 'gpt-5-mini', 1200, 95, 480, 0),\n       (NULL, NULL, 310, 40, 0, 0)\n     ) AS step(provider, model, input_tokens, output_tokens, cache_read, cache_write)`,
    [AGENT_RICH_ID, E2E_SUBJECT]
  );
  await client.query(
    `INSERT INTO llm_calls\n       (subject, agent_id, purpose, provider, model, input_tokens, output_tokens, cache_write_input_tokens, created_at)\n     VALUES ($2, $1, 'optimize', 'anthropic', 'claude-opus-5', 18400, 1900, 6200, NOW() - interval '3 hours'),\n            ($2, $3, 'run', 'anthropic', 'claude-sonnet-5', 950, 120, 0, NOW() - interval '1 day'),\n            ($2, NULL, 'chat', 'anthropic', 'claude-sonnet-5', 4100, 800, 900, NOW() - interval '2 hours')`,
    [AGENT_RICH_ID, E2E_SUBJECT, AGENT_PLAIN_ID]
  );

  // Voice-ledger rows behind the Voice card and the listener/speaker
  // boards: this person is read to a lot and talks a little, the other
  // subject the reverse, so the two boards rank them differently. Same
  // day spread as the run log. (Cleanup rides the tenant delete's cascade.)
  await client.query(
    `INSERT INTO voice_usage (subject, kind, characters, audio_ms, provider, voice, locale, created_at)\n     SELECT person.subject, piece.kind,\n            CASE WHEN piece.kind = 'speech' THEN piece.amount * person.listen ELSE 0 END,\n            CASE WHEN piece.kind = 'speech' THEN piece.amount * person.listen * 65\n                 ELSE piece.amount * person.talk END,\n            'azure-speech', CASE WHEN piece.kind = 'speech' THEN 'en-GB-SoniaNeural' END, 'en-GB',\n            NOW() - make_interval(days => spread.days_ago, mins => n)\n     FROM (VALUES (0, 3), (1, 2), (2, 4), (12, 6), (70, 9), (320, 20)) AS spread(days_ago, runs)\n     CROSS JOIN LATERAL generate_series(1, spread.runs) AS n\n     CROSS JOIN (VALUES ('speech', 420), ('transcription', 6500)) AS piece(kind, amount)\n     CROSS JOIN (VALUES ($1, 3, 1), ($2, 1, 4)) AS person(subject, listen, talk)`,
    [E2E_SUBJECT, 'e2e-colleague@example.com']
  );

  // Connectors the org has switched on. Without these the connectors page
  // renders a single card and its grid cannot be judged at all — the layout
  // only has a shape once there is more than one thing in it.
  for (const connector of [
    'atlassian',
    'atlassian-jsm',
    'atlassian-confluence',
    'webex-user',
    'microsoft',
    'zoom',
  ]) {
    await client.query(
      `INSERT INTO connector_configs (connector, enabled, encrypted_secrets, settings)\n       VALUES ($1, true, 'not-a-real-secret', '{}'::jsonb)\n       ON CONFLICT (connector) DO UPDATE SET enabled = true`,
      [connector]
    );
  }

  // Tool calls, so the Tools page has something to rank. Deliberately uneven:
  // equal counts would hide a bug in the bar widths, and a tool that fails
  // some of the time is the only way to see the "failing most" card at all.
  //
  // `otherSubject` rows belong to somebody else in the tenant — they are what
  // makes "most used across the org" differ from "most used by you", which is
  // the whole reason both cards exist.
  const otherSubject = 'e2e-colleague@example.com';
  const toolCallRows: {
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
      subject: otherSubject,
      calls: 39,
      failures: 4,
      ms: 580,
    },
    {
      tool: 'confluence_search',
      connector: 'atlassian-confluence',
      subject: otherSubject,
      calls: 28,
      failures: 0,
      ms: 700,
    },
    {
      tool: 'jira_search_issues',
      connector: 'jira',
      subject: otherSubject,
      calls: 9,
      failures: 5,
      ms: 450,
    },
    {
      tool: 'zoom_list_meetings',
      connector: 'zoom',
      subject: otherSubject,
      calls: 5,
      failures: 0,
      ms: 350,
    },
  ];
  for (const row of toolCallRows) {
    for (let index = 0; index < row.calls; index += 1) {
      const failed = index < row.failures;
      // Spread across the last three days so the trend chart has more than
      // one bar and the 24-hour period is not empty.
      const startedAt = hoursAgo(1 + (index % 60));
      await client.query(
        `INSERT INTO tool_calls\n           (id, subject, tool, connector, status, duration_ms,\n            started_at, ended_at, error_summary)\n         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.subject,
          row.tool,
          row.connector,
          failed ? 'error' : 'ok',
          row.ms + index,
          startedAt,
          new Date(startedAt.getTime() + row.ms + index),
          failed ? 'The upstream API answered 500' : null,
        ]
      );
    }
  }
}
