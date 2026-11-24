import {
  DEFAULT_INTERVAL_SECONDS,
  HEALTH_STATUSES,
  MAX_INTERVAL_SECONDS,
  readCheckin,
  readHealth,
  spanLabel,
  type HealthView,
} from './health-rules';

const ARRIVED = new Date('2026-11-24T10:00:00Z');
const checkin = (body: unknown) => {
  const read = readCheckin(body, ARRIVED);
  if (!read.ok) throw new Error(read.error);
  return read.checkin;
};
const refusal = (body: unknown) => {
  const read = readCheckin(body, ARRIVED);
  return read.ok ? null : read.error;
};

describe('a check-in as an application sends it', () => {
  it('says how it is, in one of five words', () => {
    for (const status of HEALTH_STATUSES) {
      expect(checkin({ status }).status).toBe(status);
    }
  });

  it('is refused with the list when the status is missing or not one of them', () => {
    const list = 'status is one of starting, healthy, degraded, error, stopping.';
    expect(refusal({ status: 'ok' })).toBe(list);
    expect(refusal({})).toBe(list);
    expect(refusal({ status: 7 })).toBe(list);
  });

  it('is refused when it is not an object', () => {
    for (const body of [null, 'healthy', 42, ['healthy']]) {
      expect(refusal(body)).toBe('Send a JSON object with a status.');
    }
  });

  it('may carry a line and a version: trimmed, clipped, and nothing when blank', () => {
    const read = checkin({ status: 'degraded', message: '  queue depth 3  ', version: ' 1.4.2 ' });
    expect(read.message).toBe('queue depth 3');
    expect(read.version).toBe('1.4.2');
    const long = checkin({ status: 'error', message: 'm'.repeat(900), version: 'v'.repeat(300) });
    expect(long.message).toHaveLength(500);
    expect(long.version).toHaveLength(120);
    const blank = checkin({ status: 'healthy', message: '   ', version: 12 });
    expect(blank.message).toBeNull();
    expect(blank.version).toBeNull();
  });

  it('may say when to expect the next one; without it the default applies', () => {
    expect(checkin({ status: 'healthy' }).intervalSeconds).toBeNull();
    expect(checkin({ status: 'healthy', nextCheckInSeconds: null }).intervalSeconds).toBeNull();
    expect(checkin({ status: 'healthy', nextCheckInSeconds: 300 }).intervalSeconds).toBe(300);
    expect(checkin({ status: 'healthy', nextCheckInSeconds: 90.6 }).intervalSeconds).toBe(91);
    expect(checkin({ status: 'healthy', nextCheckInSeconds: 30 }).intervalSeconds).toBe(30);
    expect(
      checkin({ status: 'healthy', nextCheckInSeconds: MAX_INTERVAL_SECONDS }).intervalSeconds
    ).toBe(MAX_INTERVAL_SECONDS);
  });

  it('refuses a next check-in under half a minute, over a week, or not a number', () => {
    const range = 'nextCheckInSeconds is between 30 and 604800 (a week).';
    expect(refusal({ status: 'healthy', nextCheckInSeconds: 5 })).toBe(range);
    expect(refusal({ status: 'healthy', nextCheckInSeconds: MAX_INTERVAL_SECONDS + 1 })).toBe(
      range
    );
    expect(refusal({ status: 'healthy', nextCheckInSeconds: '300' })).toBe(
      'nextCheckInSeconds is a number of seconds.'
    );
    expect(refusal({ status: 'healthy', nextCheckInSeconds: Number.NaN })).toBe(
      'nextCheckInSeconds is a number of seconds.'
    );
  });
});

describe('when a check-in counts from', () => {
  const sent = (sentAt: unknown) => checkin({ status: 'healthy', sentAt }).sentAt.toISOString();

  it('is when the application sent it, so time on the network is not counted', () => {
    expect(sent('2026-11-24T09:59:42Z')).toBe('2026-11-24T09:59:42.000Z');
    expect(sent(Date.parse('2026-11-24T09:30:00Z'))).toBe('2026-11-24T09:30:00.000Z');
  });

  it('is its arrival when the application does not say', () => {
    expect(checkin({ status: 'healthy' }).sentAt).toEqual(ARRIVED);
  });

  it('a clock a little ahead of Renkei’s is its arrival, not a check-in from the future', () => {
    expect(sent('2026-11-24T10:03:00Z')).toBe(ARRIVED.toISOString());
    expect(sent('2026-11-24T10:05:00Z')).toBe(ARRIVED.toISOString());
  });

  it('a time that is not believable is ignored: far ahead, long past, or not a time', () => {
    expect(sent('2026-11-24T10:06:00Z')).toBe(ARRIVED.toISOString());
    expect(sent('2026-11-23T09:59:00Z')).toBe(ARRIVED.toISOString());
    expect(sent('yesterday-ish')).toBe(ARRIVED.toISOString());
    expect(sent({ at: 1 })).toBe(ARRIVED.toISOString());
    // A day old, to the minute, is still believed: a check-in queued while offline.
    expect(sent('2026-11-23T10:00:00Z')).toBe('2026-11-23T10:00:00.000Z');
  });
});

describe('how an environment is, from its last check-in and the clock', () => {
  const SENT = Date.parse('2026-11-24T10:00:00Z');
  const view = (patch: Partial<HealthView> = {}): HealthView => ({
    tokenHint: 'x9k2',
    issuedAt: '2026-11-20T08:00:00.000Z',
    status: 'healthy',
    message: null,
    version: null,
    sentAt: new Date(SENT).toISOString(),
    receivedAt: new Date(SENT + 400).toISOString(),
    intervalSeconds: null,
    checkins: 4,
    ...patch,
  });
  const MIN = 60_000;
  const after = (minutes: number, patch?: Partial<HealthView>) =>
    readHealth(view(patch), SENT + minutes * MIN);

  it('a token nothing has checked in with yet is waiting', () => {
    expect(
      readHealth(view({ status: null, sentAt: null, receivedAt: null, checkins: 0 }), SENT)
    ).toEqual({
      state: 'waiting',
      missed: 0,
      dueAt: null,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    });
  });

  it('is as the application said while the next check-in is not overdue', () => {
    for (const status of HEALTH_STATUSES) {
      expect(after(10, { status }).state).toBe(status);
    }
  });

  it('expects the next one within 60 minutes when the application does not say', () => {
    expect(after(59)).toEqual({
      state: 'healthy',
      missed: 0,
      dueAt: '2026-11-24T11:00:00.000Z',
      intervalSeconds: 3600,
    });
  });

  it('is not late the instant one is due: it has a tenth of its interval to arrive, five minutes at most', () => {
    expect(after(60).state).toBe('healthy');
    expect(after(65).state).toBe('healthy');
    expect(after(65.1)).toMatchObject({ state: 'late', missed: 1 });
  });

  it('a short interval still has half a minute', () => {
    const patch = { intervalSeconds: 60 };
    expect(readHealth(view(patch), SENT + 90_000).state).toBe('healthy');
    expect(readHealth(view(patch), SENT + 91_000)).toMatchObject({ state: 'late', missed: 1 });
  });

  it('a mid interval has a tenth of itself', () => {
    const patch = { intervalSeconds: 600 };
    expect(after(11, patch).state).toBe('healthy');
    expect(after(11.1, patch).state).toBe('late');
  });

  it('once one is missed it is potentially failing, and stays so through the second', () => {
    expect(after(70)).toMatchObject({ state: 'late', missed: 1 });
    expect(after(126)).toMatchObject({ state: 'late', missed: 2 });
  });

  it('three missed in a row is failed', () => {
    expect(after(186)).toMatchObject({ state: 'failed', missed: 3 });
    expect(after(24 * 60)).toMatchObject({ state: 'failed' });
  });

  it('whatever it last said, silence is what counts: a degraded or erroring application fails the same way', () => {
    expect(after(70, { status: 'error' }).state).toBe('late');
    expect(after(200, { status: 'degraded' }).state).toBe('failed');
  });

  it('one that said it was stopping is stopped, not late or failed', () => {
    expect(after(10, { status: 'stopping' }).state).toBe('stopping');
    expect(after(70, { status: 'stopping' }).state).toBe('stopped');
    expect(after(600, { status: 'stopping' })).toMatchObject({ state: 'stopped', missed: 9 });
  });

  it('keeps to the rhythm the application named', () => {
    const patch = { intervalSeconds: 300 };
    expect(after(5, patch)).toEqual({
      state: 'healthy',
      missed: 0,
      dueAt: '2026-11-24T10:05:00.000Z',
      intervalSeconds: 300,
    });
    expect(after(6, patch)).toMatchObject({ state: 'late', missed: 1 });
    expect(after(16, patch)).toMatchObject({ state: 'failed', missed: 3 });
  });

  it('a status it does not know is a token still waiting', () => {
    expect(after(1, { status: 'purple' }).state).toBe('waiting');
  });
});

describe('a length of time, as people say it', () => {
  it('reads in the unit that fits', () => {
    expect(spanLabel(1)).toBe('1 second');
    expect(spanLabel(45)).toBe('45 seconds');
    expect(spanLabel(60)).toBe('60 seconds');
    expect(spanLabel(90)).toBe('2 minutes');
    expect(spanLabel(300)).toBe('5 minutes');
    expect(spanLabel(3600)).toBe('60 minutes');
    expect(spanLabel(2 * 3600)).toBe('2 hours');
    expect(spanLabel(24 * 3600)).toBe('24 hours');
    expect(spanLabel(7 * 86400)).toBe('7 days');
  });
});
