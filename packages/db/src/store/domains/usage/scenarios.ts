/**
 * The usage windows are relative to NOW() (today in the viewer's zone), so
 * these fixtures are too: rows sit at UTC noon of a day `k` days back, well
 * clear of any midnight in the zones used here, plus a few exactly on a UTC
 * midnight to pin the bounds (start inclusive, end exclusive) in UTC.
 */

import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { UsageWindow } from './types';

const DAY = 86_400_000;
const midnight = Math.floor(Date.now() / DAY) * DAY;
/** `k` days before today (UTC), at `hour` UTC. */
const ago = (k: number, hour = 12, ms = 0) => new Date(midnight - k * DAY + hour * 3_600_000 + ms);

const id = (prefix: string, n: number) =>
  `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;
const agent = (n: number) => id('a9', n);
const chat = (n: number) => id('c9', n);

const week: UsageWindow = { span: { days: 7, endOffsetDays: 0 }, timeZone: 'UTC' };
const yesterday: UsageWindow = { span: { days: 1, endOffsetDays: 1 }, timeZone: 'UTC' };
const today: UsageWindow = { span: { days: 1, endOffsetDays: 0 }, timeZone: 'UTC' };
const york: UsageWindow = { span: { days: 30, endOffsetDays: 0 }, timeZone: 'America/New_York' };
const kolkata: UsageWindow = { span: { days: 3, endOffsetDays: 2 }, timeZone: 'Asia/Kolkata' };
const WINDOWS = [week, yesterday, today, york, kolkata];

let seq = 0;
const next = (prefix: string) => id(prefix, (seq += 1));

function run(
  agentN: number,
  owner: string,
  at: Date,
  status: string,
  extra: { step?: string | null; kind?: string | null; error?: string | null; tools?: number } = {}
) {
  return {
    run_id: next('f1'),
    agent_id: agent(agentN),
    owner_subject: owner,
    trigger_kind: 'manual',
    status,
    created_at: at,
    input_tokens: 100 * agentN,
    output_tokens: 10 * agentN,
    tool_calls: extra.tools ?? 2,
    step_name: extra.step ?? null,
    error_kind: extra.kind ?? null,
    outcome_code: null,
    error: extra.error ?? null,
  };
}

function llm(
  subject: string,
  at: Date,
  input: number,
  output: number,
  extra: {
    agent?: number;
    purpose?: string;
    provider?: string | null;
    model?: string | null;
    cached?: number | null;
  } = {}
) {
  return {
    id: next('11'),
    subject,
    purpose: extra.purpose ?? (extra.agent ? 'agent' : 'chat'),
    agent_id: extra.agent ? agent(extra.agent) : null,
    provider: extra.provider === undefined ? 'anthropic' : extra.provider,
    model: extra.model === undefined ? 'sonnet' : extra.model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: extra.cached ?? null,
    created_at: at,
  };
}

function tool(subject: string | null, at: Date, name: string, status = 'ok', agentN?: number) {
  return {
    id: next('70'),
    subject,
    tool: name,
    connector: name.startsWith('jira') ? 'jira' : null,
    status,
    agent_id: agentN ? agent(agentN) : null,
    started_at: at,
    ended_at: at,
    duration_ms: 5,
  };
}

const fixture = {
  identities: [
    { subject: 'ann', email: 'ann@example.test', display_name: 'Ann' },
    { subject: 'bob', email: 'bob@example.test' },
    { subject: 'cat', email: 'cat@example.test' },
  ],
  agents: [
    { id: agent(1), name: 'triage', owner_subject: 'ann', enabled: true, tools: [] },
    { id: agent(2), name: 'digest', owner_subject: 'ann', enabled: false, tools: [] },
    { id: agent(3), name: 'bob bot', owner_subject: 'bob', enabled: true, tools: [] },
    { id: agent(4), name: 'alpha', owner_subject: 'ann', enabled: true, tools: [] },
  ],
  chat_projects: [
    { id: id('b9', 1), name: 'code', owner_subject: 'ann', kind: 'code' },
    { id: id('b9', 2), name: 'notes', owner_subject: 'ann' },
  ],
  chats: [
    { id: chat(1), owner_subject: 'ann' },
    { id: chat(2), owner_subject: 'ann', project_id: id('b9', 1) },
    { id: chat(3), owner_subject: 'ann', project_id: id('b9', 2) },
    { id: chat(4), owner_subject: 'bob' },
  ],
  chat_turns: [
    {
      id: next('d1'),
      chat_id: chat(1),
      status: 'completed',
      started_at: ago(0),
      input_tokens: 10,
      output_tokens: 1,
    },
    {
      id: next('d1'),
      chat_id: chat(1),
      status: 'completed',
      started_at: ago(1),
      input_tokens: 20,
      output_tokens: 2,
    },
    {
      id: next('d1'),
      chat_id: chat(2),
      status: 'completed',
      started_at: ago(2),
      input_tokens: 30,
      output_tokens: 3,
    },
    {
      id: next('d1'),
      chat_id: chat(3),
      status: 'completed',
      started_at: ago(3),
      input_tokens: 40,
      output_tokens: 4,
    },
    {
      id: next('d1'),
      chat_id: chat(4),
      status: 'completed',
      started_at: ago(1, 0),
      input_tokens: 50,
      output_tokens: 5,
    },
    {
      id: next('d1'),
      chat_id: chat(4),
      status: 'completed',
      started_at: ago(0, 0),
      input_tokens: 60,
      output_tokens: 6,
    },
    {
      id: next('d1'),
      chat_id: chat(4),
      status: 'completed',
      started_at: ago(6, 0),
      input_tokens: 70,
      output_tokens: 7,
    },
    {
      id: next('d1'),
      chat_id: chat(4),
      status: 'completed',
      started_at: ago(6, 0, -1),
      input_tokens: 80,
      output_tokens: 8,
    },
    {
      id: next('d1'),
      chat_id: chat(1),
      status: 'completed',
      started_at: ago(40),
      input_tokens: 90,
      output_tokens: 9,
    },
  ],
  llm_calls: [
    llm('ann', ago(0), 100, 10, { agent: 1, cached: 40 }),
    llm('ann', ago(1), 200, 20, { agent: 1, model: 'opus' }),
    llm('ann', ago(1), 50, 5, { agent: 2, provider: null, model: null }),
    llm('ann', ago(2), 70, 7),
    llm('bob', ago(1, 0), 300, 30, { agent: 3, provider: 'openai', model: 'gpt' }),
    llm('bob', ago(3), 1, 1, { purpose: 'optimize', provider: null, model: null, cached: 0 }),
    llm('cat', ago(5), 220, 0, { model: 'opus' }),
    llm('cat', ago(50), 999, 999),
  ],
  agent_run_log: [
    run(1, 'ann', ago(0), 'succeeded'),
    run(1, 'ann', ago(1), 'succeeded', { tools: 5 }),
    run(1, 'ann', ago(1, 6), 'failed', { step: 'Find', kind: 'tool', error: 'older' }),
    run(1, 'ann', ago(1, 18), 'failed', { step: 'Find', kind: 'tool', error: 'newer' }),
    run(1, 'ann', ago(2), 'failed', { step: null, kind: 'timeout', error: 'slow' }),
    run(1, 'ann', ago(2), 'succeeded'),
    run(2, 'ann', ago(1), 'failed', { step: 'Send', kind: 'tool', error: 'off agent' }),
    run(3, 'bob', ago(1), 'succeeded', { tools: 0 }),
    run(3, 'bob', ago(2), 'succeeded', { tools: 0 }),
    run(3, 'bob', ago(3), 'succeeded', { tools: 0 }),
    run(4, 'ann', ago(20), 'failed', { step: 'Old', kind: 'x', error: 'long ago' }),
  ],
  tool_calls: [
    tool('ann', ago(0), 'jira_search'),
    tool('ann', ago(1), 'jira_search', 'error'),
    tool('ann', ago(1), 'web_search', 'ok', 1),
    tool('bob', ago(2), 'web_search'),
    tool('bob', ago(2), 'jira_get', 'denied'),
    tool(null, ago(3), 'jira_get'),
    tool('ann', ago(9), 'jira_search'),
  ],
  image_usage: [
    {
      subject: 'ann',
      surface: 'chat',
      images: 2,
      image_bytes: '5000000000',
      input_tokens: 5,
      output_tokens: 50,
      created_at: ago(0),
    },
    { subject: 'bob', surface: 'chat', images: 1, image_bytes: '300', created_at: ago(1) },
    { subject: 'ann', surface: 'chat', images: 1, image_bytes: '10', created_at: ago(30) },
  ],
  voice_usage: [
    { subject: 'ann', kind: 'speech', characters: 120, audio_ms: 4000, created_at: ago(0) },
    { subject: 'ann', kind: 'speech', characters: 80, audio_ms: 2000, created_at: ago(1) },
    { subject: 'ann', kind: 'transcription', audio_ms: 9000, created_at: ago(1) },
    { subject: 'bob', kind: 'transcription', audio_ms: 1000, created_at: ago(2) },
  ],
  document_usage: [
    { subject: 'ann', kind: 'ocr', pages: 12, created_at: ago(0) },
    { subject: 'ann', kind: 'summary', input_tokens: 400, output_tokens: 40, created_at: ago(1) },
    { subject: 'bob', kind: 'describe', input_tokens: 90, output_tokens: 9, created_at: ago(2) },
    { subject: 'bob', kind: 'ocr', pages: 3, created_at: ago(45) },
  ],
};

const OWNERS = [null, 'ann', 'bob', 'nobody'];

/** Every window × every owner, for a method of (window, owner). */
async function grid<T>(call: (window: UsageWindow, owner: string | null) => Promise<T>) {
  const out: T[] = [];
  for (const window of WINDOWS) for (const owner of OWNERS) out.push(await call(window, owner));
  return out;
}

async function perWindow<T>(call: (window: UsageWindow) => Promise<T>) {
  const out: T[] = [];
  for (const window of WINDOWS) out.push(await call(window));
  return out;
}

export const usageScenarios: Scenario<DataStore>[] = [
  {
    method: 'usage.surfaceTokens',
    name: 'chat / project / code split, agents, images, documents, by window and owner',
    fixture,
    run: (store) => grid((w, o) => store.usage.surfaceTokens(w, o)),
  },
  {
    method: 'usage.surfaceTokens',
    name: 'empty ledgers',
    run: (store) => store.usage.surfaceTokens(week, null),
  },
  {
    method: 'usage.activityTotals',
    name: 'runs, failures, calls, errors, reach',
    fixture,
    run: (store) => grid((w, o) => store.usage.activityTotals(w, o)),
  },
  {
    method: 'usage.dailySeries',
    name: 'buckets by local day and hour, ascending',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.dailySeries(w, o, 'day')),
      await store.usage.dailySeries(week, null, 'hour'),
      await store.usage.dailySeries(york, 'ann', 'hour'),
    ],
  },
  {
    method: 'usage.spendBySubject',
    name: 'chat and agent spend per person, by subject',
    fixture,
    run: (store) => perWindow((w) => store.usage.spendBySubject(w)),
  },
  {
    method: 'usage.topAgentsByTokens',
    name: 'largest first, ties by id, bounded, with runs',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.topAgentsByTokens(w, o, 10)),
      await store.usage.topAgentsByTokens(week, null, 1),
    ],
  },
  {
    method: 'usage.succeededAgentRuns',
    name: 'succeeded runs per agent, at or over the minimum',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.succeededAgentRuns(w, o, 1)),
      await store.usage.succeededAgentRuns(week, null, 3),
      await store.usage.succeededAgentRuns(week, null, 4),
    ],
  },
  {
    method: 'usage.topTools',
    name: 'most called first, ties by tool then connector, bounded',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.topTools(w, o, 10)),
      await store.usage.topTools(week, null, 2),
    ],
  },
  {
    method: 'usage.tokensByModel',
    name: 'largest first, null model grouped, cached tokens summed',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.tokensByModel(w, o, 10)),
      await store.usage.tokensByModel(york, null, 2),
    ],
  },
  {
    method: 'usage.voiceByKind',
    name: 'speech and transcription',
    fixture,
    run: (store) => grid((w, o) => store.usage.voiceByKind(w, o)),
  },
  {
    method: 'usage.voiceBySubject',
    name: 'per person and kind',
    fixture,
    run: (store) => perWindow((w) => store.usage.voiceBySubject(w)),
  },
  {
    method: 'usage.imageTotals',
    name: 'pictures, int8 bytes and tokens',
    fixture,
    run: (store) => grid((w, o) => store.usage.imageTotals(w, o)),
  },
  {
    method: 'usage.imageBySubject',
    name: 'per person',
    fixture,
    run: (store) => perWindow((w) => store.usage.imageBySubject(w)),
  },
  {
    method: 'usage.documentByKind',
    name: 'ocr, summary and describe',
    fixture,
    run: (store) => grid((w, o) => store.usage.documentByKind(w, o)),
  },
  {
    method: 'usage.recordDocument',
    name: 'a recorded row counts, today',
    run: async (store) => {
      await store.usage.recordDocument({
        subject: 'ann',
        artifactId: null,
        kind: 'summary',
        pages: 0,
        inputTokens: 7,
        outputTokens: 3,
      });
      return store.usage.documentByKind(today, 'ann');
    },
  },
  {
    method: 'usage.recordImage',
    name: 'recorded pictures count, today, per person',
    run: async (store) => {
      const picture = {
        subject: 'ann',
        surface: 'images',
        provider: 'openai',
        model: 'gpt-image-1',
        imageBytes: 2048,
        width: 1024,
        height: null,
        inputTokens: 5,
        outputTokens: 9,
      };
      await store.usage.recordImage(picture);
      await store.usage.recordImage({ ...picture, imageBytes: 10, width: null });
      await store.usage.recordImage({ ...picture, subject: 'bob', inputTokens: 0 });
      return [
        await store.usage.imageBySubject(today),
        await store.usage.imageTotals(today, 'ann'),
        await store.usage.imageTotals(yesterday, 'ann'),
      ];
    },
  },
  {
    method: 'usage.recordVoice',
    name: 'recorded calls count, today, by kind and person',
    run: async (store) => {
      await store.usage.recordVoice({
        subject: 'ann',
        kind: 'speech',
        characters: 120,
        audioMs: 4000,
        provider: 'azure',
        voice: 'en-US-Ava',
        locale: 'en-US',
      });
      await store.usage.recordVoice({
        subject: 'ann',
        kind: 'transcription',
        characters: 0,
        audioMs: 1500,
        provider: 'azure',
        voice: null,
        locale: null,
      });
      await store.usage.recordVoice({
        subject: 'bob',
        kind: 'speech',
        characters: 3,
        audioMs: 10,
        provider: 'azure',
        voice: null,
        locale: 'de-DE',
      });
      return [
        await store.usage.voiceByKind(today, 'ann'),
        await store.usage.voiceBySubject(today),
        await store.usage.voiceByKind(yesterday, null),
      ];
    },
  },
  {
    method: 'usage.personTotals',
    name: 'one person across ledgers, chat share',
    fixture,
    run: (store) => grid((w, o) => store.usage.personTotals(o ?? 'cat', w)),
  },
  {
    method: 'usage.personSeries',
    name: 'one person by day and hour',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.personSeries(o ?? 'cat', w, 'day')),
      await store.usage.personSeries('ann', week, 'hour'),
    ],
  },
  {
    method: 'usage.personAgents',
    name: 'own agents by name, newest failure each',
    fixture,
    run: (store) => grid((w, o) => store.usage.personAgents(o ?? 'cat', w)),
  },
  {
    method: 'usage.failureSignatures',
    name: 'grouped, most frequent then newest, enabled agents only, bounded',
    fixture,
    run: async (store) => [
      await grid((w, o) => store.usage.failureSignatures(o ?? 'cat', w, 5)),
      await store.usage.failureSignatures('ann', week, 1),
    ],
  },
  {
    method: 'usage.recordLlmCall',
    name: 'a recorded call counts toward its run, by model',
    fixture: {
      agents: [{ id: '00000000-0000-4000-8000-140000000001', owner_subject: 'ann', name: 'A' }],
      agent_runs: [
        {
          id: '00000000-0000-4000-8000-140000000002',
          agent_id: '00000000-0000-4000-8000-140000000001',
          owner_subject: 'ann',
          trigger_kind: 'manual',
        },
      ],
    },
    run: async (store) => {
      const runId = '00000000-0000-4000-8000-140000000002';
      const call = {
        subject: 'ann',
        agentId: '00000000-0000-4000-8000-140000000001',
        runId,
        stepId: null,
        purpose: 'run',
        inputTokens: 120,
        outputTokens: 30,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: null,
        llmModelId: null,
        provider: 'anthropic',
        model: 'claude-x',
        durationMs: 900,
      };
      await store.usage.recordLlmCall(call);
      await store.usage.recordLlmCall({ ...call, inputTokens: 5, outputTokens: 1, model: 'other' });
      return store.agentUsage.runTokensByModel(runId);
    },
  },
];
