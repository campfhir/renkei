/**
 * Who a connector is for (audience-control.model.ts), as an operator would
 * describe it. What the audience route stores is its route test
 * (app/api/admin/connector-audience/[capabilityKey]/route.test.ts); the
 * browser spec (connector-audience-hint.spec.ts) keeps the no-claim state
 * rendered on the real server and at phone width.
 */

import {
  audienceReducer,
  claimHint,
  failedSave,
  initialAudience,
  savedNotice,
  savesOnChoose,
  type AudienceAction,
  type AudienceState,
} from './audience-control.model';

const run = (actions: AudienceAction[], from: AudienceState) =>
  actions.reduce(audienceReducer, from);

describe('opening', () => {
  it('opens on Everyone with no rule on file, and on the groups with one', () => {
    expect(initialAudience([]).mode).toBe('everyone');
    expect(initialAudience(['eng']).mode).toBe('groups');
    expect(initialAudience(['eng']).values).toEqual(['eng']);
  });
});

describe('choosing', () => {
  it('choosing Everyone with groups named empties the list and saves it empty', () => {
    const state = initialAudience(['eng', 'ops']);
    expect(savesOnChoose(state, 'everyone')).toEqual([]);
    expect(run([{ type: 'choose', mode: 'everyone' }], state).values).toEqual([]);
  });

  it('choosing Everyone when it already offers everyone saves nothing', () => {
    expect(savesOnChoose(initialAudience([]), 'everyone')).toBeNull();
  });

  it('choosing only some groups saves nothing until a group is added', () => {
    const state = initialAudience([]);
    expect(savesOnChoose(state, 'groups')).toBeNull();
    const chosen = run([{ type: 'choose', mode: 'groups' }], state);
    expect(chosen.mode).toBe('groups');
    expect(chosen.values).toEqual([]);
  });

  it('keeps the groups named when switching to groups', () => {
    const state = { ...initialAudience(['eng']), mode: 'everyone' as const };
    expect(run([{ type: 'choose', mode: 'groups' }], state).values).toEqual(['eng']);
  });
});

describe('saving', () => {
  it('says how many groups it is limited to, by the connector’s name', () => {
    expect(savedNotice(['eng'], 'Bitbucket')).toBe(
      'Saved. Only people in 1 group are offered Bitbucket; tool lists refresh within a minute.'
    );
    expect(savedNotice(['eng', 'ops'], 'Jira')).toContain(
      'Only people in 2 groups are offered Jira'
    );
  });

  it('says it is offered to everyone again when the list empties', () => {
    expect(savedNotice([], 'Jira')).toBe('Saved. Offered to everyone again.');
  });

  it('a save in flight clears the last message; a refusal shows the route’s words', () => {
    const state = run(
      [
        { type: 'values', values: ['eng'] },
        { type: 'saving' },
        { type: 'saved', notice: 'ok' },
        { type: 'saving' },
      ],
      initialAudience([])
    );
    expect(state.notice).toBeNull();
    expect(state.busy).toBe(true);
    const failed = audienceReducer(state, {
      type: 'save-failed',
      error: failedSave({ error: 'At most 50 groups' }),
    });
    expect(failed.error).toBe('At most 50 groups');
    expect(failed.busy).toBe(false);
    expect(failed.values).toEqual(['eng']);
  });

  it('a refusal with no words says it could not save', () => {
    expect(failedSave(null)).toBe('Could not save');
    expect(failedSave({ message: 'x' })).toBe('Could not save');
  });
});

describe('where groups come from', () => {
  it('with no groups claim, says nobody is in a group', () => {
    expect(claimHint(null, 12)).toEqual({ kind: 'no-claim' });
  });

  it('with a claim, names it and how many values sign-ins have recorded', () => {
    expect(claimHint('member_of', 1)).toEqual({
      kind: 'claim',
      claim: 'member_of',
      seen: '1 distinct value seen so far.',
    });
    expect(claimHint('member_of', 0).kind === 'claim' && claimHint('member_of', 0)).toMatchObject({
      seen: '0 distinct values seen so far.',
    });
  });
});
