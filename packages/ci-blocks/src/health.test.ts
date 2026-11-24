import { healthChange, isTroubled, readHealth } from './health';

const AT = Date.parse('2026-11-24T10:00:00Z');
const HOUR = 3_600_000;
const checkedIn = (
  status: string,
  announcedState: string | null,
  intervalSeconds: number | null = null
) => ({
  status,
  sentAt: new Date(AT).toISOString(),
  intervalSeconds,
  announcedState,
});

describe('how an application is, from its last check-in and the clock', () => {
  it('is what it last said until the next check-in is overdue', () => {
    expect(readHealth(checkedIn('healthy', null), AT + HOUR).state).toBe('healthy');
  });

  it('is potentially failing once one is missed, and failed at three', () => {
    expect(readHealth(checkedIn('healthy', null), AT + HOUR + 6 * 60_000).state).toBe('late');
    expect(readHealth(checkedIn('healthy', null), AT + 3 * HOUR + 6 * 60_000)).toMatchObject({
      state: 'failed',
      missed: 3,
    });
  });

  it('is stopped, not late, when it said it was stopping', () => {
    expect(readHealth(checkedIn('stopping', null), AT + 5 * HOUR).state).toBe('stopped');
  });
});

describe('the change to announce', () => {
  it('is none before the first check-in', () => {
    expect(
      healthChange({ status: null, sentAt: null, intervalSeconds: null, announcedState: null }, AT)
    ).toBeNull();
  });

  it('is none while the state is the one last announced', () => {
    expect(healthChange(checkedIn('healthy', 'healthy'), AT + 60_000)).toBeNull();
  });

  it('is the first state an application reports', () => {
    expect(healthChange(checkedIn('starting', null), AT)).toEqual({
      from: null,
      to: 'starting',
      missed: 0,
    });
  });

  it('is going quiet: healthy to potentially failing, then to failed', () => {
    expect(healthChange(checkedIn('healthy', 'healthy', 60), AT + 2 * 60_000)).toEqual({
      from: 'healthy',
      to: 'late',
      missed: 1,
    });
    expect(healthChange(checkedIn('healthy', 'late', 60), AT + 4 * 60_000)).toMatchObject({
      from: 'late',
      to: 'failed',
    });
  });

  it('is coming back: failed to healthy at the next check-in', () => {
    expect(healthChange(checkedIn('healthy', 'failed'), AT)).toMatchObject({
      from: 'failed',
      to: 'healthy',
    });
  });
});

describe('which states need someone', () => {
  it('are a reported problem, going quiet and stopping', () => {
    expect(['degraded', 'error', 'late', 'failed', 'stopped'].every(isTroubled)).toBe(true);
    expect(['starting', 'healthy', 'stopping', null].some(isTroubled)).toBe(false);
  });
});
