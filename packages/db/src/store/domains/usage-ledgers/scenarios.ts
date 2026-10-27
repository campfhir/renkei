import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { Bucketing, LedgerFilter } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Hours after 2026-03-07T00:00Z — the US switches to daylight time on 03-08. */
const at = (hour: number) => new Date(Date.UTC(2026, 2, 7, 0) + hour * 3_600_000);

const AGENT_A = id(101);
const AGENT_B = id(102);
const AGENT_OFF = id(103);

function llm(n: number, hour: number, subject: string, fields: Record<string, unknown> = {}) {
  return {
    id: id(n),
    subject,
    purpose: 'agent',
    input_tokens: n * 10,
    output_tokens: n,
    created_at: at(hour),
    ...fields,
  };
}

function run(
  n: number,
  hour: number,
  agent: string,
  owner: string,
  fields: Record<string, unknown> = {}
) {
  return {
    run_id: id(200 + n),
    agent_id: agent,
    owner_subject: owner,
    trigger_kind: 'schedule',
    status: 'succeeded',
    input_tokens: n * 100,
    output_tokens: n * 10,
    tool_calls: n,
    created_at: at(hour),
    ...fields,
  };
}

function turn(n: number, hour: number, chat: number, input: number, output: number) {
  return {
    id: id(400 + n),
    chat_id: id(300 + chat),
    status: 'done',
    input_tokens: input,
    output_tokens: output,
    started_at: at(hour),
  };
}

const fixture = {
  identities: [
    { subject: 'ann', email: 'ann@example.test', display_name: 'Ann' },
    { subject: 'bob', email: 'bob@example.test' },
  ],
  agents: [
    { id: AGENT_A, name: 'Triage', owner_subject: 'ann', enabled: true },
    { id: AGENT_B, name: 'Digest', owner_subject: 'ann', enabled: true },
    { id: AGENT_OFF, name: 'Old', owner_subject: 'bob', enabled: false },
  ],
  llm_calls: [
    llm(1, 1, 'ann', { purpose: 'chat', provider: 'openai', model: 'gpt-5' }),
    llm(2, 2, 'ann', {
      agent_id: AGENT_A,
      provider: 'openai',
      model: 'gpt-5',
      cache_read_input_tokens: 7,
    }),
    llm(3, 5, 'ann', { agent_id: AGENT_B, provider: 'anthropic', model: 'claude' }),
    llm(4, 27, 'bob', { agent_id: AGENT_OFF }),
    llm(5, 28, 'bob', { purpose: 'chat', provider: 'anthropic', model: 'claude' }),
    llm(6, 80, 'cy', { purpose: 'chat' }),
  ],
  agent_run_log: [
    run(1, 1, AGENT_A, 'ann'),
    run(2, 2, AGENT_A, 'ann', {
      status: 'failed',
      step_name: 'Find',
      error_kind: 'tool',
      error: 'first',
    }),
    run(3, 3, AGENT_A, 'ann', {
      status: 'failed',
      step_name: 'Find',
      error_kind: 'tool',
      error: 'second',
    }),
    run(4, 4, AGENT_A, 'ann'),
    run(5, 5, AGENT_A, 'ann'),
    run(6, 6, AGENT_B, 'ann', {
      status: 'failed',
      step_name: null,
      error_kind: 'llm',
      outcome_code: 'x',
    }),
    run(7, 26, AGENT_B, 'ann'),
    run(8, 27, AGENT_OFF, 'bob', { status: 'failed', step_name: 'Send', error: 'off' }),
  ],
  chat_projects: [
    { id: id(501), name: 'Docs', owner_subject: 'ann' },
    { id: id(502), name: 'Repo', owner_subject: 'ann', kind: 'code' },
  ],
  chats: [
    { id: id(301), owner_subject: 'ann' },
    { id: id(302), owner_subject: 'ann', project_id: id(501) },
    { id: id(303), owner_subject: 'ann', project_id: id(502) },
    { id: id(304), owner_subject: 'bob' },
  ],
  chat_turns: [
    turn(1, 1, 1, 100, 10),
    turn(2, 3, 2, 200, 20),
    turn(3, 4, 3, 300, 30),
    turn(4, 26, 1, 5, 5),
    turn(5, 27, 4, 50, 5),
  ],
  image_usage: [
    {
      id: id(601),
      subject: 'ann',
      surface: 'chat',
      images: 2,
      image_bytes: '5000',
      input_tokens: 10,
      output_tokens: 20,
      created_at: at(2),
    },
    { id: id(602), subject: 'ann', surface: 'chat', image_bytes: '1000', created_at: at(30) },
    { id: id(603), subject: 'bob', surface: 'chat', image_bytes: '700', created_at: at(3) },
  ],
  voice_usage: [
    {
      id: id(701),
      subject: 'ann',
      kind: 'speech',
      characters: 120,
      audio_ms: 9000,
      created_at: at(1),
    },
    { id: id(702), subject: 'ann', kind: 'transcription', audio_ms: 4000, created_at: at(2) },
    {
      id: id(703),
      subject: 'bob',
      kind: 'speech',
      characters: 30,
      audio_ms: 2000,
      created_at: at(3),
    },
    {
      id: id(704),
      subject: 'ann',
      kind: 'speech',
      characters: 10,
      audio_ms: 500,
      created_at: at(29),
    },
  ],
  document_usage: [
    { id: id(801), subject: 'ann', kind: 'ocr', pages: 4, created_at: at(1) },
    {
      id: id(802),
      subject: 'ann',
      kind: 'summary',
      input_tokens: 300,
      output_tokens: 40,
      created_at: at(2),
    },
    {
      id: id(803),
      subject: 'bob',
      kind: 'describe',
      input_tokens: 90,
      output_tokens: 9,
      created_at: at(28),
    },
  ],
};

const all: LedgerFilter = { window: { since: at(0) } };
const firstDay: LedgerFilter = { window: { since: at(0), until: at(24) } };
const ann: LedgerFilter = { window: { since: at(0) }, subject: 'ann' };
const nobody: LedgerFilter = { window: { since: at(1000) } };
const days: Bucketing = { timeZone: 'America/New_York', granularity: 'day' };
const hours: Bucketing = { timeZone: 'Asia/Kolkata', granularity: 'hour' };

/** One scenario per method, each over the shared fixture. */
function scenario(
  method: keyof DataStore['usageLedgers'],
  name: string,
  run: (ledgers: DataStore['usageLedgers']) => Promise<unknown>
): Scenario<DataStore> {
  return {
    method: `usageLedgers.${method}`,
    name,
    fixture,
    run: (store) => run(store.usageLedgers),
  };
}

export const usageLedgerScenarios: Scenario<DataStore>[] = [
  scenario('llmTotals', 'org, scoped, agents only, bounded, empty', async (l) => [
    await l.llmTotals(all),
    await l.llmTotals(ann),
    await l.llmTotals({ ...all, agentsOnly: true }),
    await l.llmTotals(firstDay),
    await l.llmTotals(nobody),
  ]),
  scenario('llmSeries', 'local days and hours', async (l) => [
    await l.llmSeries(all, days),
    await l.llmSeries({ ...ann, agentsOnly: true }, hours),
    await l.llmSeries(nobody, days),
  ]),
  scenario('llmByAgent', 'among the given agents', async (l) => [
    await l.llmByAgent({ ...all, agentIds: [AGENT_B, AGENT_A, AGENT_OFF] }),
    await l.llmByAgent({ ...ann, agentIds: [AGENT_OFF] }),
    await l.llmByAgent({ ...all, agentIds: [] }),
  ]),
  scenario('agentLlmBySubject', 'agent spend per payer', async (l) => [
    await l.agentLlmBySubject(all),
    await l.agentLlmBySubject(firstDay),
  ]),
  scenario('topAgentsByTokens', 'largest first, bounded, scoped', async (l) => [
    await l.topAgentsByTokens(all, 10),
    await l.topAgentsByTokens(all, 1),
    await l.topAgentsByTokens(ann, 10),
  ]),
  scenario('tokensByModel', 'largest first, null model last among ties', async (l) => [
    await l.tokensByModel(all, 10),
    await l.tokensByModel(ann, 1),
    await l.tokensByModel(nobody, 10),
  ]),
  scenario('countActiveSubjects', 'distinct spenders', async (l) => [
    await l.countActiveSubjects(all.window),
    await l.countActiveSubjects(firstDay.window),
    await l.countActiveSubjects(nobody.window),
  ]),
  scenario('runTotals', 'runs and failures', async (l) => [
    await l.runTotals(all),
    await l.runTotals(ann),
    await l.runTotals(firstDay),
    await l.runTotals(nobody),
  ]),
  scenario('runSeries', 'per local bucket', async (l) => [
    await l.runSeries(all, days),
    await l.runSeries(ann, hours),
  ]),
  scenario('runsByAgent', 'among the given agents', async (l) => [
    await l.runsByAgent({ ...ann, agentIds: [AGENT_A, AGENT_B] }),
    await l.runsByAgent({ ...firstDay, agentIds: [AGENT_B, AGENT_OFF] }),
    await l.runsByAgent({ ...all, agentIds: [] }),
  ]),
  scenario('lastFailureByAgent', 'newest failure per agent', async (l) => [
    await l.lastFailureByAgent({ ...ann, agentIds: [AGENT_A, AGENT_B] }),
    await l.lastFailureByAgent({ window: { since: at(3), until: at(5) }, agentIds: [AGENT_A] }),
    await l.lastFailureByAgent({ ...all, agentIds: [] }),
  ]),
  scenario('failureSignatures', 'enabled agents, most frequent then most recent', async (l) => [
    await l.failureSignatures(ann, 5),
    await l.failureSignatures(all, 1),
    await l.failureSignatures({ ...all, subject: 'bob' }, 5),
  ]),
  scenario('succeededRunStats', 'agents with enough succeeded runs', async (l) => [
    await l.succeededRunStats(all, 3),
    await l.succeededRunStats(all, 1),
    await l.succeededRunStats(firstDay, 1),
  ]),
  scenario('chatTokensBySurface', 'chat, project and code', async (l) => [
    await l.chatTokensBySurface(all),
    await l.chatTokensBySurface({ ...all, subject: 'bob' }),
    await l.chatTokensBySurface(nobody),
  ]),
  scenario('chatSeriesBySurface', 'per bucket and surface', async (l) => [
    await l.chatSeriesBySurface(all, days),
    await l.chatSeriesBySurface(ann, hours),
  ]),
  scenario('chatTokensBySubject', 'per chat owner', async (l) => [
    await l.chatTokensBySubject(all),
    await l.chatTokensBySubject(firstDay),
  ]),
  scenario('imageTotals', 'pictures, bytes and tokens', async (l) => [
    await l.imageTotals(all),
    await l.imageTotals(ann),
    await l.imageTotals(nobody),
  ]),
  scenario('imageSeries', 'per bucket', async (l) => [await l.imageSeries(all, days)]),
  scenario('imageBySubject', 'per person', async (l) => [
    await l.imageBySubject(all),
    await l.imageBySubject(firstDay),
  ]),
  scenario('voiceByKind', 'speech and transcription', async (l) => [
    await l.voiceByKind(all),
    await l.voiceByKind({ ...firstDay, subject: 'ann' }),
    await l.voiceByKind(nobody),
  ]),
  scenario('voiceBySubjectKind', 'per person and kind', async (l) => [
    await l.voiceBySubjectKind(all),
  ]),
  scenario('documentByKind', 'per kind', async (l) => [
    await l.documentByKind(all),
    await l.documentByKind(ann),
  ]),
  scenario('documentSeries', 'per bucket', async (l) => [
    await l.documentSeries(all, days),
    await l.documentSeries({ ...all, subject: 'bob' }, hours),
  ]),
  scenario('insertDocumentUsage', 'counted after', async (l) => {
    await l.insertDocumentUsage({
      subject: 'cy',
      artifactId: null,
      kind: 'ocr',
      pages: 3,
      inputTokens: 0,
      outputTokens: 0,
    });
    return l.documentByKind({ window: { since: new Date(Date.now() - 60_000) }, subject: 'cy' });
  }),
  scenario('ownedAgents', 'by name', async (l) => [
    await l.ownedAgents('ann'),
    await l.ownedAgents('cy'),
  ]),
  scenario('countPeople', 'everyone signed in', async (l) => l.countPeople()),
];
