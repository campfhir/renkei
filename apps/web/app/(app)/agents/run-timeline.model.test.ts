import type { ActionBatchView, AttemptView } from '@/lib/agents/runs-view';
import {
  CLAMP_CHARS,
  batchHeading,
  batchVerdict,
  batchesByTurn,
  clampOf,
  compactionHeading,
  finishWording,
  reviewReasonWording,
  runTimesLine,
} from './run-timeline.model';

function batch(overrides: Partial<ActionBatchView>): ActionBatchView {
  return {
    id: 'batch-1',
    turn: 1,
    status: 'proposed',
    actionCount: 2,
    acceptedBy: null,
    reviewReason: null,
    createdAt: '2026-11-01T08:00:00Z',
    finishedAt: null,
    ...overrides,
  };
}

function turn(attempt: number): AttemptView {
  return {
    stepId: 'step-1',
    stepIndex: 0,
    attempt,
    iteration: 0,
    status: 'succeeded',
    outcome: null,
    outcomeCode: null,
    toolCallCount: 0,
    startedAt: null,
    finishedAt: null,
    redacted: true,
  };
}

describe('a run’s timeline', () => {
  it('heads a staged batch with how many changes it proposes', () => {
    expect(batchHeading({ actionCount: 2 })).toBe('Proposed 2 changes');
    expect(batchHeading({ actionCount: 1 })).toBe('Proposed 1 change');
  });

  it('says what became of a batch, and who let it through', () => {
    const verdict = (status: string, acceptedBy: string | null = null) =>
      batchVerdict(batch({ status, acceptedBy }));
    expect(verdict('proposed')).toBe('Waiting for your go-ahead.');
    expect(verdict('declined')).toBe('Declined — none of these were made.');
    expect(verdict('expired')).toBe('Nobody accepted it in time — none of these were made.');
    expect(verdict('accepted', 'alice')).toBe('Accepted — being carried out.');
    expect(verdict('executing', 'auto')).toBe('Accepted automatically — being carried out.');
    expect(verdict('completed', 'alice')).toBe('Accepted and carried out.');
    expect(verdict('completed', 'auto')).toBe('Accepted automatically and carried out.');
  });

  it('says why a batch needed a person, when there is a reason worth saying', () => {
    expect(reviewReasonWording('high-risk')).toBe(
      'Needed a person: it includes a high-risk action.'
    );
    expect(reviewReasonWording('policy')).toBe(
      'Needed a person: your organization requires it for this run.'
    );
    expect(reviewReasonWording(null)).toBeNull();
  });

  it('says how a finishing turn ended the run', () => {
    expect(finishWording('done')).toBe('Finished — the goal was met.');
    expect(finishWording('nothing_to_do')).toBe(
      'Finished — there was nothing to do for this input.'
    );
    expect(finishWording('failed')).toBe('Gave up — the agent could not reach its goal.');
    expect(finishWording(undefined)).toBeNull();
  });

  it('draws each batch at the turn that staged it, in order', () => {
    const byTurn = batchesByTurn([
      batch({ id: 'a', turn: 1 }),
      batch({ id: 'b', turn: 3 }),
      batch({ id: 'c', turn: 1 }),
    ]);
    expect(byTurn.get(1)?.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(byTurn.get(3)?.map((entry) => entry.id)).toEqual(['b']);
    expect(byTurn.get(2)).toBeUndefined();
  });

  it('clamps a long detail behind "Show all", counting its characters', () => {
    expect(clampOf('x'.repeat(CLAMP_CHARS))).toBeNull();
    const long = 'x'.repeat(6_200);
    expect(clampOf(long)).toEqual({
      preview: `${'x'.repeat(CLAMP_CHARS)}…`,
      showAll: `Show all (${(6_200).toLocaleString()} characters)`,
    });
  });

  it('counts turns and active time, adding wall time once the run has finished', () => {
    const attempts = [turn(1), turn(2)];
    expect(
      runTimesLine({ attempts, activeMs: 0, startedAt: '2026-11-01T08:00:00Z', finishedAt: null })
    ).toMatch(/^2 turns · active time .+ — time spent waiting on you is not counted/);
    const finished = runTimesLine({
      attempts: attempts.slice(1),
      activeMs: 0,
      startedAt: '2026-11-01T08:00:00Z',
      finishedAt: '2026-11-01T08:05:00Z',
    });
    expect(finished).toMatch(/^1 turn · active time .+ · wall time /);
  });

  it('names the turns folded into notes', () => {
    expect(compactionHeading(1)).toBe('Turn 1 folded into notes to fit the model’s context');
    expect(compactionHeading(4)).toBe('Turns 1–4 folded into notes to fit the model’s context');
  });
});
