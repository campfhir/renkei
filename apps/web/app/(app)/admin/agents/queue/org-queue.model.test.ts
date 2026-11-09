import {
  haltRequest,
  haltSelectedLabel,
  initOrgQueue,
  isLiveTab,
  orgQueueReducer,
  pickAllOffer,
  queueRows,
  selectAllState,
  tabLabels,
  type OrgQueueAction,
  type OrgQueueRun,
} from './org-queue.model';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function run(over: Partial<OrgQueueRun>): OrgQueueRun {
  return {
    id: 'r1',
    agentId: 'a1',
    agentName: 'Triage',
    ownerSubject: 'sub-ann',
    ownerEmail: 'ann@example.test',
    status: 'queued',
    triggerKind: 'schedule',
    createdAt: ago(5 * MIN),
    startedAt: null,
    resumedAt: null,
    cancelRequestedAt: null,
    ...over,
  };
}

const fold = (actions: OrgQueueAction[]) => actions.reduce(orgQueueReducer, initOrgQueue());

describe('the organization queue rows', () => {
  it('say which agent, whose, and how long each run has waited', () => {
    const [queued, running, waiting] = queueRows(
      [
        run({ id: 'q', createdAt: ago(3 * 60 * MIN) }),
        run({ id: 'r', status: 'running', createdAt: ago(30 * MIN), startedAt: ago(12 * MIN) }),
        run({ id: 'w', status: 'waiting', createdAt: ago(3 * 24 * 60 * MIN) }),
      ],
      NOW
    );
    expect(queued).toMatchObject({
      agentName: 'Triage',
      owner: 'ann@example.test',
      age: '3 h in queue',
      stuck: true,
    });
    expect(running).toMatchObject({ age: 'running 12 min', stuck: false });
    // A run waiting on a person is never stuck, however long.
    expect(waiting).toMatchObject({ age: 'waiting 3 d', stuck: false });
  });

  it('count a resumed run from its resume, and show the owner by subject when there is no email', () => {
    const [row] = queueRows(
      [run({ createdAt: ago(9 * 24 * 60 * MIN), resumedAt: ago(4 * MIN), ownerEmail: null })],
      NOW
    );
    expect(row).toMatchObject({ age: '4 min in queue', stuck: false, owner: 'sub-ann' });
  });

  it('flag a run whose cancel was asked for and never landed', () => {
    const [row] = queueRows([run({ cancelRequestedAt: ago(MIN) })], NOW);
    expect(row.cancelAsked).toBe(true);
  });
});

describe('the tabs', () => {
  it('carry each live status count and the total', () => {
    expect(
      tabLabels([
        { status: 'queued', count: 9 },
        { status: 'running', count: 1 },
      ]).map((tab) => tab.label)
    ).toEqual(['All 10', 'Queued 9', 'Running 1', 'Waiting 0']);
  });

  it('accept only live statuses from the URL', () => {
    expect(['queued', 'running', 'waiting', 'failed', undefined].map(isLiveTab)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('halting from the queue view', () => {
  const rows = queueRows(
    [run({ id: 'r1' }), run({ id: 'r2', agentId: 'a2' }), run({ id: 'r3' })],
    NOW
  );
  const ids = rows.map((row) => row.id);

  it('picks rows one by one and sends just those, with their agents', () => {
    const state = fold([
      { type: 'toggle', runId: 'r2' },
      { type: 'toggle', runId: 'r3' },
      { type: 'toggle', runId: 'r3' },
    ]);
    expect(haltRequest(state, rows)).toEqual({ runs: [{ agentId: 'a2', runId: 'r2' }] });
    expect(selectAllState(state, ids)).toBe('some');
    expect(haltSelectedLabel(state, rows)).toBe('Halt 1 selected');
  });

  it('the select-all box picks every row, then none', () => {
    const all = fold([{ type: 'toggleAll', runIds: ids }]);
    expect(selectAllState(all, ids)).toBe('all');
    expect(haltSelectedLabel(all, rows)).toBe('Halt 3 selected');
    const none = orgQueueReducer(all, { type: 'toggleAll', runIds: ids });
    expect(selectAllState(none, ids)).toBe('none');
    expect(haltSelectedLabel(none, rows)).toBeNull();
  });

  it('halted runs leave the selection and cannot be sent again', () => {
    const state = fold([
      { type: 'toggleAll', runIds: ids },
      { type: 'haltStarted', runIds: ids },
      { type: 'haltAnswered', halted: ['r1', 'r2', 'r3'], refused: [] },
    ]);
    expect(state).toMatchObject({
      selected: [],
      halting: [],
      halted: ['r1', 'r2', 'r3'],
      error: null,
    });
    expect(haltRequest(state, rows).runs).toEqual([]);
    // With every row halted there is nothing for the box to pick.
    expect(selectAllState(orgQueueReducer(state, { type: 'toggleAll', runIds: ids }), ids)).toBe(
      'none'
    );
  });

  it('while a halt is in flight the button says so, and nothing is sent twice', () => {
    const state = fold([
      { type: 'toggleAll', runIds: ids },
      { type: 'haltStarted', runIds: ids },
    ]);
    expect(haltRequest(state, rows).runs).toEqual([]);
    expect(haltSelectedLabel(state, rows)).toBe('Halting…');
  });

  it('a run that had already finished is reported, and the rest still halt', () => {
    const state = fold([
      { type: 'toggleAll', runIds: ids },
      { type: 'haltStarted', runIds: ids },
      {
        type: 'haltAnswered',
        halted: ['r1', 'r3'],
        refused: [{ runId: 'r2', error: 'This run already succeeded.' }],
      },
    ]);
    expect(state.halted).toEqual(['r1', 'r3']);
    expect(state.selected).toEqual(['r2']);
    expect(state.error).toBe('Run r2 was not halted: This run already succeeded.');
  });

  it('a halt the server refused keeps the selection and says why', () => {
    const state = fold([
      { type: 'toggle', runId: 'r1' },
      { type: 'haltStarted', runIds: ['r1'] },
      { type: 'haltFailed', runIds: ['r1'], error: 'Unauthorized' },
    ]);
    expect(state).toMatchObject({
      selected: ['r1'],
      halting: [],
      halted: [],
      error: 'Unauthorized',
    });
    expect(haltSelectedLabel(state, rows)).toBe('Halt 1 selected');
  });
});

describe('picking every run of the tab, not just this page', () => {
  const rows = queueRows([run({ id: 'r1' }), run({ id: 'r2' })], NOW);
  const ids = rows.map((row) => row.id);

  it('is offered once the whole page is picked and the tab has more', () => {
    expect(pickAllOffer(fold([{ type: 'toggle', runId: 'r1' }]), ids, 908)).toBeNull();
    const page = fold([{ type: 'toggleAll', runIds: ids }]);
    expect(pickAllOffer(page, ids, 908)).toEqual({
      text: 'All 2 on this page are picked.',
      action: 'pick',
    });
    // Nothing more to offer when the page is the whole tab.
    expect(pickAllOffer(page, ids, 2)).toBeNull();
  });

  it('once taken, the button halts them all, and unticking the page lets go', () => {
    const all = fold([{ type: 'toggleAll', runIds: ids }, { type: 'pickAllMatching' }]);
    expect(haltSelectedLabel(all, rows, 1078)).toBe('Halt all 1,078');
    expect(pickAllOffer(all, ids, 1078)).toEqual({
      text: 'All 1,078 runs are picked.',
      action: 'clear',
    });
    const off = orgQueueReducer(all, { type: 'toggleAll', runIds: ids });
    expect(off.allMatching).toBe(false);
    expect(haltSelectedLabel(off, rows, 1078)).toBeNull();
    expect(orgQueueReducer(all, { type: 'clearAllMatching' })).toMatchObject({
      allMatching: false,
      selected: [],
    });
  });

  it('counts the batches up as they land, and says what it did at the end', () => {
    const started = fold([
      { type: 'toggleAll', runIds: ids },
      { type: 'pickAllMatching' },
      { type: 'allHaltStarted', total: 450 },
    ]);
    expect(haltSelectedLabel(started, rows, 450)).toBe('Halting… 0 of 450');
    const midway = orgQueueReducer(started, { type: 'allHaltBatch', halted: 200, remaining: 250 });
    expect(haltSelectedLabel(midway, rows, 450)).toBe('Halting… 200 of 450');
    const batches: OrgQueueAction[] = [
      { type: 'allHaltBatch', halted: 200, remaining: 50 },
      { type: 'allHaltBatch', halted: 50, remaining: 0 },
    ];
    const finished = batches.reduce(orgQueueReducer, midway);
    expect(finished).toMatchObject({
      progress: null,
      allMatching: false,
      selected: [],
      done: 'Halted 450 runs.',
    });
  });

  it('stops when a batch halts nothing, and says how many are left', () => {
    const state = fold([
      { type: 'pickAllMatching' },
      { type: 'allHaltStarted', total: 10 },
      { type: 'allHaltBatch', halted: 7, remaining: 3 },
      { type: 'allHaltBatch', halted: 0, remaining: 3 },
    ]);
    expect(state).toMatchObject({ progress: null, done: 'Halted 7; 3 could not be halted.' });
  });

  it('a failed batch stops it and says how far it got', () => {
    const state = fold([
      { type: 'pickAllMatching' },
      { type: 'allHaltStarted', total: 600 },
      { type: 'allHaltBatch', halted: 200, remaining: 400 },
      { type: 'allHaltFailed', error: 'Unauthorized' },
    ]);
    expect(state).toMatchObject({
      progress: null,
      allMatching: true,
      error: 'Unauthorized (200 were halted before it stopped.)',
    });
  });
});
