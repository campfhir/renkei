import type { LiveRunCount } from '@/lib/agents/runs-view';
import {
  STUCK_AFTER_MS,
  ageWords,
  overviewHeadline,
  overviewOf,
  type OverviewAgent,
} from './agents-overview.model';

const NOW = Date.parse('2026-11-08T20:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function agent(id: string, name: string, extra: Partial<OverviewAgent> = {}): OverviewAgent {
  return { id, name, enabled: true, shared: false, ...extra };
}

function live(
  agentId: string,
  status: LiveRunCount['status'],
  count: number,
  ageMs: number
): LiveRunCount {
  return { agentId, status, count, oldestCreatedAt: ago(ageMs) };
}

describe('the agents overview', () => {
  it('shows an agent with nothing queued, running or waiting as idle', () => {
    const { rows } = overviewOf([agent('a', 'Triage')], [], NOW);
    expect(rows[0]).toMatchObject({
      state: 'idle',
      inFlight: 'Nothing in flight',
      oldestAge: null,
      href: '/agents/a/runs',
    });
  });

  it('a run queued past the stuck horizon makes the agent stuck, and links to its queued runs', () => {
    const { rows } = overviewOf(
      [agent('a', 'Weekday')],
      [live('a', 'queued', 5, 2 * 24 * HOUR)],
      NOW
    );
    expect(rows[0]).toMatchObject({
      state: 'stuck',
      queued: 5,
      inFlight: '5 queued',
      oldestAge: '2 d',
      href: '/agents/a/runs?status=queued',
    });
  });

  it('a run running past the horizon is stuck too, and its running runs are what to open', () => {
    const { rows } = overviewOf(
      [agent('m', 'Mailbox')],
      [live('m', 'queued', 7, 3 * HOUR), live('m', 'running', 3, 7 * 24 * HOUR)],
      NOW
    );
    expect(rows[0]).toMatchObject({
      state: 'stuck',
      inFlight: '7 queued · 3 running',
      oldestAge: '7 d',
      href: '/agents/m/runs?status=running',
    });
  });

  it('a fresh run is busy, not stuck — right up to the horizon', () => {
    const { rows } = overviewOf(
      [agent('a', 'Triage')],
      [live('a', 'running', 1, STUCK_AFTER_MS)],
      NOW
    );
    expect(rows[0]?.state).toBe('busy');
  });

  it('a run waiting on the owner reads as needing them, however old', () => {
    const { rows } = overviewOf(
      [agent('s', 'Sunday')],
      [live('s', 'waiting', 1, 3 * 24 * HOUR)],
      NOW
    );
    expect(rows[0]).toMatchObject({
      state: 'needs-you',
      inFlight: '1 waiting',
      href: '/agents/s/runs?status=waiting',
    });
  });

  it('puts what needs attention first: stuck, then waiting on you, then busy, then idle, by name', () => {
    const { rows } = overviewOf(
      [
        agent('1', 'Zed idle'),
        agent('2', 'Busy one'),
        agent('3', 'Waiting one'),
        agent('4', 'B stuck'),
        agent('5', 'A stuck'),
      ],
      [
        live('2', 'queued', 1, 5 * MIN),
        live('3', 'waiting', 1, 5 * MIN),
        live('4', 'queued', 1, 3 * HOUR),
        live('5', 'running', 1, 3 * HOUR),
      ],
      NOW
    );
    expect(rows.map((row) => row.name)).toEqual([
      'A stuck',
      'B stuck',
      'Waiting one',
      'Busy one',
      'Zed idle',
    ]);
  });

  it('counts only an agent’s own runs, and keeps an agent shared with you marked as shared', () => {
    const { rows } = overviewOf(
      [agent('mine', 'Mine'), agent('theirs', 'Theirs', { shared: true, enabled: false })],
      [live('theirs', 'queued', 2, 5 * MIN), live('elsewhere', 'queued', 9, 5 * MIN)],
      NOW
    );
    expect(rows.map((row) => [row.name, row.queued, row.shared, row.enabled])).toEqual([
      ['Theirs', 2, true, false],
      ['Mine', 0, false, true],
    ]);
  });
});

describe('the overview headline', () => {
  it('says so when nothing is in flight', () => {
    expect(overviewHeadline(overviewOf([agent('a', 'A')], [], NOW))).toBe(
      'Nothing in flight right now.'
    );
  });

  it('totals the live runs and names what needs attention', () => {
    const overview = overviewOf(
      [agent('a', 'A'), agent('b', 'B'), agent('c', 'C')],
      [
        live('a', 'queued', 50, 3 * HOUR),
        live('b', 'waiting', 1, 5 * MIN),
        live('c', 'running', 1, 5 * MIN),
      ],
      NOW
    );
    expect(overviewHeadline(overview)).toBe('52 runs in flight — 1 stuck, 1 waiting on you.');
  });

  it('a single healthy run reads plainly', () => {
    const overview = overviewOf([agent('a', 'A')], [live('a', 'running', 1, MIN)], NOW);
    expect(overviewHeadline(overview)).toBe('1 run in flight.');
  });
});

describe('ages', () => {
  it('uses the largest whole unit, days from two days on', () => {
    expect([30_000, 5 * MIN, 3 * HOUR, 47 * HOUR, 49 * HOUR, 8 * 24 * HOUR].map(ageWords)).toEqual([
      '30 s',
      '5 min',
      '3 h',
      '47 h',
      '2 d',
      '8 d',
    ]);
  });
});
