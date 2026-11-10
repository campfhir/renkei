import {
  decidedLine,
  decisionBody,
  initRow,
  partitionRequests,
  rowReducer,
  type ListedRequest,
  type RowAction,
  type RowState,
} from './size-requests.model';

const GB = 1_073_741_824;

function request(id: string, status: ListedRequest['status'], extra: Partial<ListedRequest> = {}) {
  return {
    id,
    projectName: `Project ${id}`,
    requestedBytes: 24 * GB,
    status,
    decisionNote: null,
    ...extra,
  };
}

function run(...actions: RowAction[]): RowState {
  return actions.reduce(rowReducer, initRow(24 * GB));
}

describe('the checkout size requests list', () => {
  it('shows the waiting requests as rows, and at most ten decided ones below', () => {
    const decided = Array.from({ length: 12 }, (_, n) =>
      request(`d${n}`, n % 2 ? 'approved' : 'denied')
    );
    const { pending, decided: shown } = partitionRequests([request('p1', 'pending'), ...decided]);
    expect(pending.map((item) => item.id)).toEqual(['p1']);
    expect(shown).toHaveLength(10);
    expect(shown[0].id).toBe('d0');
  });

  it('with nothing waiting, there are no rows to decide', () => {
    expect(partitionRequests([request('d1', 'approved')]).pending).toEqual([]);
  });

  it('a decided request says its size and outcome, with the admin’s note if there was one', () => {
    expect(
      decidedLine(request('a', 'approved', { projectName: 'Monorepo', requestedBytes: 20 * GB }))
    ).toBe('Monorepo — 20 GB approved');
    expect(
      decidedLine(
        request('b', 'denied', {
          projectName: 'Monorepo',
          requestedBytes: 40 * GB,
          decisionNote: 'Prune first',
        })
      )
    ).toBe('Monorepo — 40 GB denied (Prune first)');
  });
});

describe('one waiting request', () => {
  it('offers to approve what was asked', () => {
    expect(run().approveGb).toBe(24);
  });

  it('Approve sends the size the admin chose, in bytes, with the note', () => {
    const state = run(
      { type: 'approveGbChanged', gb: 20 },
      { type: 'noteChanged', note: 'Enough for now' }
    );
    expect(decisionBody(state, 'approved')).toEqual({
      decision: 'approved',
      note: 'Enough for now',
      approvedBytes: 20 * GB,
    });
  });

  it('Deny sends the note and no size', () => {
    const state = run({ type: 'noteChanged', note: 'Prune build output first' });
    expect(decisionBody(state, 'denied')).toEqual({
      decision: 'denied',
      note: 'Prune build output first',
    });
  });

  it('both buttons are off while a decision is in flight', () => {
    expect(run({ type: 'sent' }).busy).toBe(true);
    expect(run({ type: 'sent' }, { type: 'decided' }).busy).toBe(false);
  });

  it('a refused decision stays on the row with the server’s words, and clears on the next try', () => {
    const failed = run({ type: 'sent' }, { type: 'failed', error: 'That request is not pending' });
    expect(failed.error).toBe('That request is not pending');
    expect(failed.busy).toBe(false);
    expect(rowReducer(failed, { type: 'sent' }).error).toBeNull();
  });
});
