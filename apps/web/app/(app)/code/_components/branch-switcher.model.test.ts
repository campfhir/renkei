/**
 * The Switch branch dialog (branch-switcher.model.ts), as a person using
 * it would describe it — including the dirty-tree refusal and the
 * discard that lets the switch through, which branch-switcher.spec.ts
 * walked in a browser before. The spec keeps the overflow menu opening
 * the dialog and one switch reaching the title bar's label.
 */

import {
  blockedNotice,
  branchReducer,
  canPick,
  errorCodeOf,
  initialBranch,
  type BranchAction,
  type BranchState,
} from './branch-switcher.model';

const DIRTY =
  'There are uncommitted changes on the checkout. Commit or discard them before switching branches.';

const run = (actions: BranchAction[], from: BranchState = initialBranch('main')) =>
  actions.reduce(branchReducer, from);

const listed = run([
  {
    type: 'loaded',
    branches: [
      { name: 'main', headSha: 'aaa' },
      { name: 'feature/x', headSha: 'bbb' },
    ],
  },
]);

const refusedDirty = run(
  [
    { type: 'switchStarted' },
    { type: 'switchRefused', branch: 'feature/x', error: DIRTY, code: 'dirty' },
  ],
  listed
);

describe('the list', () => {
  it('says nothing until the branches answer, then lists them', () => {
    expect(initialBranch('main').branches).toBeNull();
    expect(listed.branches?.map((branch) => branch.name)).toEqual(['main', 'feature/x']);
  });

  it('a list that cannot be read says why', () => {
    expect(run([{ type: 'loadFailed', error: 'Bitbucket said no' }]).loadError).toBe(
      'Bitbucket said no'
    );
  });

  it('the branch the checkout is on cannot be picked again, nor anything while a switch goes', () => {
    expect(canPick(listed, 'main')).toBe(false);
    expect(canPick(listed, 'feature/x')).toBe(true);
    expect(canPick(run([{ type: 'switchStarted' }], listed), 'feature/x')).toBe(false);
  });
});

describe('switching', () => {
  it('a switch that goes through shows the new branch at once', () => {
    const switched = run(
      [{ type: 'switchStarted' }, { type: 'switched', branch: 'feature/x' }],
      listed
    );
    expect(switched.shown).toBe('feature/x');
    expect(switched.switching).toBe(false);
    expect(blockedNotice(switched)).toBeNull();
  });

  it('a refusal mid-turn says why, with no discard offered', () => {
    const busy = run(
      [
        { type: 'switchStarted' },
        { type: 'switchRefused', branch: 'feature/x', error: 'A turn is running.', code: 'busy' },
      ],
      listed
    );
    expect(blockedNotice(busy)).toEqual({ message: 'A turn is running.', discard: null });
    expect(busy.shown).toBe('main');
  });

  it('a dirty tree is refused with the reason and a way through: discard and switch', () => {
    expect(blockedNotice(refusedDirty)).toEqual({
      message: DIRTY,
      discard: 'Discard changes and switch to feature/x',
    });
    expect(refusedDirty.pendingBranch).toBe('feature/x');
  });

  it('discarding says so while it goes, then the retried switch lands on the branch asked for', () => {
    const discarding = run([{ type: 'discardStarted' }], refusedDirty);
    expect(blockedNotice(discarding)?.discard).toBe('Discarding…');
    const through = run(
      [{ type: 'discarded' }, { type: 'switchStarted' }, { type: 'switched', branch: 'feature/x' }],
      discarding
    );
    expect(through.shown).toBe('feature/x');
    expect(through.pendingBranch).toBeNull();
    expect(blockedNotice(through)).toBeNull();
  });

  it('a refused discard shows why and keeps the offer to try again', () => {
    const failed = run(
      [
        { type: 'discardStarted' },
        { type: 'discardRefused', error: 'The sandbox is down.', code: null },
      ],
      refusedDirty
    );
    expect(blockedNotice(failed)).toEqual({
      message: 'The sandbox is down.',
      discard: 'Discard changes and switch to feature/x',
    });
  });

  it('a refusal with no code (a server error, no connection) is still shown', () => {
    const plain = run(
      [
        { type: 'switchStarted' },
        {
          type: 'switchRefused',
          branch: 'feature/x',
          error: 'Could not reach the server',
          code: null,
        },
      ],
      listed
    );
    expect(blockedNotice(plain)).toEqual({ message: 'Could not reach the server', discard: null });
  });

  it('a later refusal that is not about a dirty tree drops the discard offer', () => {
    const other = run(
      [
        { type: 'switchStarted' },
        { type: 'switchRefused', branch: 'feature/x', error: 'Gone.', code: 'not-found' },
      ],
      refusedDirty
    );
    expect(blockedNotice(other)?.discard).toBeNull();
  });

  it('follows the project when its branch moves for another reason', () => {
    expect(run([{ type: 'branchChanged', branch: 'release' }], listed).shown).toBe('release');
  });
});

describe('reading a refusal', () => {
  it('takes the code from the error body, and nothing from anything else', () => {
    expect(errorCodeOf({ error: DIRTY, code: 'dirty' })).toBe('dirty');
    expect(errorCodeOf({ error: 'x' })).toBeNull();
    expect(errorCodeOf({ code: 4 })).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
    expect(errorCodeOf(['dirty'])).toBeNull();
  });
});
