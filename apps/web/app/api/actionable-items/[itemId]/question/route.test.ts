/**
 * What a question card's "Send the answers" reaches, on the memory store:
 * the answers stored as sent (a skipped question absent, "Something else"
 * kept with what was written), the run woken; a form the answers do not
 * satisfy is a 422 whose issues the card marks under each control; a lost
 * wake is a 502 with a warning the card shows (the answer is saved); a
 * second answer is a 409. (agent-instructions.spec.ts used to check the
 * stored answers through a browser.)
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/queue', () => ({ agentJobsQueue: jest.fn() }));

import { NextRequest } from 'next/server';
import { askedQuestionsOf } from '@renkei/agents';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  toJson,
  type NewRow,
  type TableRows,
} from '@renkei/db';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { agentJobsQueue: mockQueue } = jest.requireMock<{ agentJobsQueue: jest.Mock }>(
  '@renkei/queue'
);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGENT = id(1);
const RUN = id(11);
const CARD = id(22);

/** The batch the agent asked through ask_person, as the engine records it on the card. */
const asked = askedQuestionsOf({
  intro: 'ATLAS Lab Harvest went live on Azure; two things need a home.',
  questions: [
    {
      question: 'Should the ATLAS go-live status go on CIO-5, CIO-25 or CIO-26?',
      answer: { type: 'choice', options: ['CIO-5', 'CIO-25', 'CIO-26'] },
    },
    {
      question: 'Does the xCures SFTP work need a CIO-39 update?',
      answer: { type: 'choice', options: ['Yes', 'No'] },
    },
  ],
});
if (!asked.ok) throw new Error(asked.error);

const created = new Date('2026-10-20T09:00:00.000Z');

function fixture(): TableRows {
  const card: NewRow<'actionable_items'> = {
    id: CARD,
    owner_subject: 'alice',
    source: 'agent',
    kind: 'question',
    title: 'Portfolio Updater — has a question',
    summary: asked.ok ? asked.message : '',
    run_id: RUN,
    created_by_agent_id: AGENT,
    suggested_action: toJson({
      message: asked.ok ? asked.message : '',
      form: asked.ok ? asked.form : [],
    }),
    evidence: {},
    status: 'suggested',
    result: null,
    created_by: null,
    step_id: null,
    attempt: null,
    iteration: null,
    decided_at: null,
    decided_by: null,
    archived_at: null,
    archived_by: null,
    created_at: created,
    updated_at: created,
  };
  return {
    agents: [{ id: AGENT, owner_subject: 'alice', name: 'Portfolio Updater' }],
    agent_runs: [
      {
        id: RUN,
        agent_id: AGENT,
        owner_subject: 'alice',
        trigger_kind: 'manual',
        status: 'waiting',
        trigger_id: null,
        triggered_by_subject: null,
        parent_run_id: null,
        lineage: [],
        depth: 0,
        definition_snapshot: null,
        legacy_steps_snapshot: null,
        initial_state: null,
        llm_model_id: null,
        current_step_id: null,
        error: null,
        error_kind: null,
        active_ms: '0',
        started_at: null,
        finished_at: null,
        waiting_until: null,
        cancel_requested_at: null,
        cancel_requested_by: null,
        resume_count: 0,
        resume_failure: null,
        resume_guidance: null,
        resume_step_id: null,
        resumed_at: null,
        resumed_by: null,
        created_at: created,
        updated_at: created,
      },
    ],
    actionable_items: [card],
  };
}

const store = createMemoryDataStore();
const enqueue = jest.fn();

function send(answers: unknown): Promise<Response> {
  return POST(
    new NextRequest(`http://test.local/api/actionable-items/${CARD}/question`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
    { params: Promise.resolve({ itemId: CARD }) }
  );
}

function storedCard() {
  return store.tables.first('actionable_items', (row) => row.id === CARD);
}

beforeEach(async () => {
  store.reset();
  await store.seed(fixture());
  registerDataStore(store);
  mockGetSession.mockResolvedValue({ subject: 'alice' });
  enqueue.mockReset().mockResolvedValue({ ok: true });
  mockQueue.mockReturnValue({ producer: { enqueue } });
});

afterAll(() => resetDataStore());

describe('POST /api/actionable-items/:id/question', () => {
  it('stores the answers as sent — a skipped question absent — and wakes the run', async () => {
    const response = await send({
      q1: 'Something else: A new CIO-41 issue for the Azure cutover',
      anything_else: 'Kelvin owns the SFTP piece.',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'answered' });
    expect(storedCard()?.status).toBe('answered');
    expect(storedCard()?.result).toEqual({
      answers: {
        q1: 'Something else: A new CIO-41 issue for the Azure cutover',
        anything_else: 'Kelvin owns the SFTP piece.',
      },
      decidedBy: 'alice',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run', payload: { runId: RUN } })
    );
  });

  it('a "Something else" with nothing written is a 422 the card marks, and nothing is stored', async () => {
    const response = await send({ q1: 'Something else: ' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Some answers need another look.',
      issues: [expect.objectContaining({ name: 'q1', message: 'Say what it is.' })],
    });
    expect(storedCard()?.status).toBe('suggested');
  });

  it('a saved answer whose run could not be woken is a 502 with a warning', async () => {
    enqueue.mockResolvedValue({ ok: false });
    const response = await send({ q2: 'Yes' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: 'answered',
      warning: 'Your answer is saved; the run will resume automatically shortly.',
    });
    expect(storedCard()?.status).toBe('answered');
  });

  it('a second answer is refused with 409', async () => {
    expect((await send({ q2: 'No' })).status).toBe(200);
    const again = await send({ q2: 'Yes' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Item is already answered' });
  });

  it('is a 404 for someone else, and a 401 without a session', async () => {
    mockGetSession.mockResolvedValue({ subject: 'bob' });
    expect((await send({ q2: 'Yes' })).status).toBe(404);
    mockGetSession.mockResolvedValue(null);
    expect((await send({ q2: 'Yes' })).status).toBe(401);
  });
});
