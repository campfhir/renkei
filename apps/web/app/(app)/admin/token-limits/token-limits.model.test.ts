import {
  boostHasEffect,
  boostRequest,
  boostTotal,
  canGrant,
  canSave,
  draftPolicy,
  initTokenLimits,
  isDirty,
  limitsAnything,
  minuteToTime,
  saveRequest,
  timeToMinute,
  timeZoneOptions,
  tokenLimitsReducer,
  visiblePeople,
  type Person,
  type TokenLimitsAction,
  type TokenLimitsState,
  type TokenLimitsView,
} from './token-limits.model';

const OPUS = '00000000-0000-4000-8000-000000000901';
const HAIKU = '00000000-0000-4000-8000-000000000902';
const GONE = '00000000-0000-4000-8000-000000000903';

function person(subject: string, overrides: Partial<Person> = {}): Person {
  return {
    subject,
    name: subject,
    email: `${subject}@example.com`,
    exempt: false,
    weekUsed: 0,
    monthUsed: 0,
    boosts: [],
    ...overrides,
  };
}

function view(overrides: Partial<TokenLimitsView> = {}): TokenLimitsView {
  return {
    policy: {
      weekly: 0,
      monthly: 0,
      weekResetDay: 1,
      weekResetMinute: 0,
      timeZone: 'UTC',
      models: {},
    },
    weekResetsAt: '2026-11-16T00:00:00.000Z',
    monthResetsAt: '2026-12-01T00:00:00.000Z',
    models: [
      { id: OPUS, label: 'Opus', enabled: true },
      { id: HAIKU, label: 'Haiku', enabled: true },
    ],
    people: [
      person('ada', { name: 'Ada Lovelace' }),
      person('grace', { name: 'Grace Hopper', email: 'ghopper@navy.example' }),
    ],
    ...overrides,
  };
}

function fold(state: TokenLimitsState, ...actions: TokenLimitsAction[]): TokenLimitsState {
  return actions.reduce(tokenLimitsReducer, state);
}

describe('the organization limits', () => {
  it('opens on what is stored: no limits, the week resetting Monday at 00:00 UTC', () => {
    const state = initTokenLimits(view());
    expect(state.draft).toMatchObject({
      timeZone: 'UTC',
      weekly: '',
      monthly: '',
      weekResetDay: 1,
      weekResetTime: '00:00',
    });
    expect(canSave(state)).toBe(false);
    expect(isDirty(state)).toBe(false);
    expect(limitsAnything(state.view.policy)).toBe(false);
  });

  it('a typed weekly limit turns Save on, and Save sends only that', () => {
    const state = fold(initTokenLimits(view()), {
      type: 'limitsChanged',
      patch: { weekly: '2M' },
    });
    expect(canSave(state)).toBe(true);
    expect(saveRequest(state)).toEqual({ weekly: 2_000_000 });
  });

  it('Save is off while an amount does not read, and nothing is sent', () => {
    const state = fold(initTokenLimits(view()), {
      type: 'limitsChanged',
      patch: { weekly: 'lots' },
    });
    expect(draftPolicy(state)).toBeNull();
    expect(canSave(state)).toBe(false);
    expect(saveRequest(state)).toBeNull();
    // Something is still unsaved: the page says so.
    expect(isDirty(state)).toBe(true);
  });

  it('clearing a limit removes it', () => {
    const stored = view({
      policy: {
        weekly: 5_000_000,
        monthly: 0,
        weekResetDay: 1,
        weekResetMinute: 0,
        timeZone: 'UTC',
        models: {},
      },
    });
    const state = fold(initTokenLimits(stored), { type: 'limitsChanged', patch: { weekly: '' } });
    expect(saveRequest(state)).toEqual({ weekly: 0 });
  });

  it('the weekly reset moves to the day and time chosen, in UTC', () => {
    const state = fold(initTokenLimits(view()), {
      type: 'limitsChanged',
      patch: { weekResetDay: 5, weekResetTime: '17:30' },
    });
    expect(saveRequest(state)).toEqual({ weekResetDay: 5, weekResetMinute: 1050 });
  });

  it('the resets move to the time zone chosen, and only that is sent', () => {
    const state = fold(initTokenLimits(view()), {
      type: 'limitsChanged',
      patch: { timeZone: 'America/New_York' },
    });
    expect(canSave(state)).toBe(true);
    expect(saveRequest(state)).toEqual({ timeZone: 'America/New_York' });
  });

  it('the zone picker offers UTC first, and keeps a stored zone the browser does not list', () => {
    const supported = ['America/New_York', 'Europe/Paris'];
    expect(timeZoneOptions('UTC', supported)).toEqual(['UTC', 'America/New_York', 'Europe/Paris']);
    expect(timeZoneOptions('Europe/Paris', supported)).toEqual([
      'UTC',
      'America/New_York',
      'Europe/Paris',
    ]);
    expect(timeZoneOptions('Etc/GMT+5', supported)).toEqual([
      'Etc/GMT+5',
      'UTC',
      'America/New_York',
      'Europe/Paris',
    ]);
  });

  it('typing a limit back to what is stored leaves nothing to save', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'limitsChanged', patch: { monthly: '8M' } },
      { type: 'limitsChanged', patch: { monthly: '' } }
    );
    expect(canSave(state)).toBe(false);
  });

  it('a stored answer fills the fields with what the server kept', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'limitsChanged', patch: { weekly: '2500000' } },
      { type: 'saveSent' },
      {
        type: 'saved',
        view: view({
          policy: {
            weekly: 2_500_000,
            monthly: 0,
            weekResetDay: 1,
            weekResetMinute: 0,
            timeZone: 'UTC',
            models: {},
          },
        }),
      }
    );
    expect(state.phase).toBe('saved');
    expect(state.draft.weekly).toBe('2.5M');
    expect(canSave(state)).toBe(false);
  });

  it('a refused save keeps what was typed and shows why', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'limitsChanged', patch: { weekly: '2M' } },
      { type: 'saveSent' },
      { type: 'saveFailed', error: 'Could not save the token limits' }
    );
    expect(state.draft.weekly).toBe('2M');
    expect(state.error).toBe('Could not save the token limits');
    expect(canSave(state)).toBe(true);
  });

  it('Save is off while a save is in flight', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'limitsChanged', patch: { weekly: '2M' } },
      { type: 'saveSent' }
    );
    expect(canSave(state)).toBe(false);
  });
});

describe('limits on a model', () => {
  it('a model with a limit is sent by itself', () => {
    const state = fold(initTokenLimits(view()), {
      type: 'modelChanged',
      modelId: OPUS,
      patch: { weekly: '500k' },
    });
    expect(saveRequest(state)).toEqual({ models: { [OPUS]: { weekly: 500_000, monthly: 0 } } });
  });

  it('clearing both of a model’s limits removes its entry', () => {
    const stored = view({
      policy: {
        weekly: 0,
        monthly: 0,
        weekResetDay: 1,
        weekResetMinute: 0,
        timeZone: 'UTC',
        models: { [OPUS]: { weekly: 500_000, monthly: 2_000_000 } },
      },
    });
    const state = fold(initTokenLimits(stored), {
      type: 'modelChanged',
      modelId: OPUS,
      patch: { weekly: '', monthly: '' },
    });
    expect(saveRequest(state)).toEqual({ models: { [OPUS]: null } });
  });

  it('an untouched model, and one the roster no longer lists, are not sent', () => {
    const stored = view({
      policy: {
        weekly: 0,
        monthly: 0,
        weekResetDay: 1,
        weekResetMinute: 0,
        timeZone: 'UTC',
        models: { [OPUS]: { weekly: 500_000, monthly: 0 }, [GONE]: { weekly: 1, monthly: 0 } },
      },
    });
    const state = fold(initTokenLimits(stored), {
      type: 'modelChanged',
      modelId: HAIKU,
      patch: { monthly: '9M' },
    });
    expect(saveRequest(state)).toEqual({ models: { [HAIKU]: { weekly: 0, monthly: 9_000_000 } } });
  });

  it('a model amount that does not read holds Save back', () => {
    const state = fold(initTokenLimits(view()), {
      type: 'modelChanged',
      modelId: OPUS,
      patch: { weekly: 'x' },
    });
    expect(canSave(state)).toBe(false);
  });
});

describe('people', () => {
  it('the filter matches name, email or subject', () => {
    const state = initTokenLimits(view());
    const names = (filter: string) =>
      visiblePeople(fold(state, { type: 'filterChanged', filter })).map((p) => p.subject);
    expect(names('')).toEqual(['ada', 'grace']);
    expect(names('hopper')).toEqual(['grace']);
    expect(names('NAVY')).toEqual(['grace']);
    expect(names('ada')).toEqual(['ada']);
    expect(names('nobody')).toEqual([]);
  });

  it('a boost form opens for one person, for the week', () => {
    const state = fold(initTokenLimits(view()), { type: 'boostOpened', subject: 'ada' });
    expect(state.boost).toEqual({ subject: 'ada', period: 'week', tokens: '', note: '' });
    expect(canGrant(state)).toBe(false);
  });

  it('Grant is on once the amount is above zero, and sends the person, period and amount', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'boostOpened', subject: 'ada' },
      { type: 'boostChanged', patch: { tokens: '250k', period: 'month', note: ' quarter close ' } }
    );
    expect(canGrant(state)).toBe(true);
    expect(boostRequest(state)).toEqual({
      subject: 'ada',
      period: 'month',
      tokens: 250_000,
      note: 'quarter close',
    });
  });

  it('a boost of nothing, or of text, is not granted', () => {
    const open = fold(initTokenLimits(view()), { type: 'boostOpened', subject: 'ada' });
    for (const tokens of ['0', '', 'some']) {
      expect(canGrant(fold(open, { type: 'boostChanged', patch: { tokens } }))).toBe(false);
    }
  });

  it('a granted boost closes the form and shows on the person', () => {
    const granted = view({
      people: [
        person('ada', {
          boosts: [
            {
              id: 'b1',
              period: 'week',
              tokens: 250_000,
              expiresAt: '2026-11-16T00:00:00.000Z',
              note: null,
            },
            {
              id: 'b2',
              period: 'week',
              tokens: 50_000,
              expiresAt: '2026-11-16T00:00:00.000Z',
              note: null,
            },
          ],
        }),
      ],
    });
    const state = fold(
      initTokenLimits(view()),
      { type: 'boostOpened', subject: 'ada' },
      { type: 'boostChanged', patch: { tokens: '250k' } },
      { type: 'personSent', key: 'ada' },
      { type: 'personStored', view: granted }
    );
    expect(state.boost).toBeNull();
    expect(state.busy).toBeNull();
    expect(boostTotal(state.view.people[0], 'week')).toBe(300_000);
    expect(boostTotal(state.view.people[0], 'month')).toBe(0);
  });

  it('a refused grant keeps the form and what was typed, and shows why', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'boostOpened', subject: 'ada' },
      { type: 'boostChanged', patch: { tokens: '250k' } },
      { type: 'personSent', key: 'ada' },
      { type: 'personFailed', error: 'No such person' }
    );
    expect(state.boost?.tokens).toBe('250k');
    expect(state.personError).toBe('No such person');
    expect(canGrant(state)).toBe(true);
  });

  it('nothing else is granted while a change to a person is in flight', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'boostOpened', subject: 'ada' },
      { type: 'boostChanged', patch: { tokens: '250k' } },
      { type: 'personSent', key: 'ada' }
    );
    expect(canGrant(state)).toBe(false);
  });

  it('a change to a person keeps an unsaved limits edit', () => {
    const state = fold(
      initTokenLimits(view()),
      { type: 'limitsChanged', patch: { weekly: '2M' } },
      { type: 'personSent', key: 'ada' },
      { type: 'personStored', view: view({ people: [person('ada', { exempt: true })] }) }
    );
    expect(state.draft.weekly).toBe('2M');
    expect(state.view.people[0].exempt).toBe(true);
    expect(canSave(state)).toBe(true);
  });

  it('a boost only has an effect on a period the organization limits', () => {
    const policy = {
      weekly: 1_000_000,
      monthly: 0,
      weekResetDay: 1,
      weekResetMinute: 0,
      timeZone: 'UTC',
      models: {},
    };
    expect(boostHasEffect(policy, 'week')).toBe(true);
    expect(boostHasEffect(policy, 'month')).toBe(false);
  });
});

it('a time of day reads both ways', () => {
  expect(minuteToTime(0)).toBe('00:00');
  expect(minuteToTime(1050)).toBe('17:30');
  expect(timeToMinute('17:30')).toBe(1050);
  expect(timeToMinute('9:05')).toBe(545);
  expect(timeToMinute('24:00')).toBeNull();
  expect(timeToMinute('noon')).toBeNull();
});
