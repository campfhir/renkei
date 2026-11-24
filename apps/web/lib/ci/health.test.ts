/**
 * Health check-ins on the server, on the memory store: a token is issued
 * and kept only as its hash, a check-in made with it is recorded for its
 * environment, and a token that was replaced or taken away is a stranger.
 * The interface and how lateness is read are health-rules.test.ts.
 */

import { createHash } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  checkInUrl,
  hashToken,
  healthView,
  issueHealthToken,
  recordCheckIn,
  revokeHealthToken,
} from './health';

const PROJECT = '00000000-0000-4000-8000-000000000h01'.replace('h', 'a');
const ISSUED = new Date('2026-11-24T09:00:00Z');
const NOW = new Date('2026-11-24T10:00:00Z');

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

const listed = () => getDataStore().ciHealth.listForProject(PROJECT);
const send = (token: string | null, body: unknown, now = NOW) =>
  recordCheckIn({ authorization: token === null ? null : `Bearer ${token}`, body, now });

describe('an environment’s token', () => {
  it('is answered once, and kept only as its hash', async () => {
    const { token, hint } = await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    expect(token).toMatch(/^rkh_[A-Za-z0-9_-]{40,}$/);
    expect(hint).toBe(token.slice(-4));
    expect(hashToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    const [record] = await listed();
    expect(record).toMatchObject({
      environment: 'production',
      tokenHint: hint,
      issuedBy: 'auth0|ada',
      status: null,
      checkins: 0,
    });
    expect(JSON.stringify(record)).not.toContain(token);
  });

  it('is a different one each time', async () => {
    const one = await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    const two = await issueHealthToken(PROJECT, 'dev', 'auth0|ada', ISSUED);
    expect(one.token).not.toBe(two.token);
  });
});

describe('a check-in', () => {
  it('is recorded for the environment its token names', async () => {
    const { token } = await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    const outcome = await send(token, {
      status: 'degraded',
      message: 'queue depth 40',
      version: '1.4.2',
      sentAt: '2026-11-24T09:59:30Z',
      nextCheckInSeconds: 300,
    });
    expect(outcome.ok && outcome.record).toMatchObject({
      projectId: PROJECT,
      environment: 'production',
      status: 'degraded',
      message: 'queue depth 40',
      version: '1.4.2',
      sentAt: new Date('2026-11-24T09:59:30Z'),
      receivedAt: NOW,
      intervalSeconds: 300,
      checkins: 1,
    });
    const again = await send(token, { status: 'healthy' }, new Date('2026-11-24T10:05:00Z'));
    expect(again.ok && again.record).toMatchObject({
      status: 'healthy',
      message: null,
      intervalSeconds: null,
      checkins: 2,
    });
  });

  it('without a bearer token, or with something that is not one of Renkei’s, is not taken', async () => {
    for (const authorization of [null, '', 'Basic abc', 'Bearer', 'Bearer not-a-health-token']) {
      const outcome = await recordCheckIn({ authorization, body: { status: 'healthy' }, now: NOW });
      expect(outcome).toEqual({
        ok: false,
        status: 401,
        error: 'Send the environment’s health token as a bearer token.',
      });
    }
  });

  it('with a token Renkei never issued is refused', async () => {
    await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    expect(await send('rkh_made-up-by-someone-else', { status: 'healthy' })).toEqual({
      ok: false,
      status: 401,
      error: 'That health token is not one Renkei issued, or it was replaced.',
    });
    expect((await listed())[0]?.checkins).toBe(0);
  });

  it('that does not say how it is is refused, and nothing is recorded', async () => {
    const { token } = await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    const outcome = await send(token, { status: 'fine' });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    expect((await listed())[0]?.status).toBeNull();
  });
});

describe('replacing and taking away', () => {
  it('a new token stops the old one at once, and keeps the last check-in', async () => {
    const old = await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    await send(old.token, { status: 'healthy', version: '1.0.0' });
    const fresh = await issueHealthToken(PROJECT, 'production', 'auth0|bob', NOW);
    expect(await send(old.token, { status: 'error' })).toMatchObject({ ok: false, status: 401 });
    const [record] = await listed();
    expect(record).toMatchObject({
      tokenHint: fresh.hint,
      issuedBy: 'auth0|bob',
      status: 'healthy',
      version: '1.0.0',
      checkins: 1,
    });
    expect(await send(fresh.token, { status: 'starting' })).toMatchObject({ ok: true });
  });

  it('a token taken away stops checking in, and its health is gone', async () => {
    const { token } = await issueHealthToken(PROJECT, 'dev', 'auth0|ada', ISSUED);
    await send(token, { status: 'healthy' });
    expect(await revokeHealthToken(PROJECT, 'dev')).toBe(true);
    expect(await revokeHealthToken(PROJECT, 'dev')).toBe(false);
    expect(await listed()).toEqual([]);
    expect(await send(token, { status: 'healthy' })).toMatchObject({ ok: false, status: 401 });
  });
});

describe('what the page is given', () => {
  it('is the last check-in with its times as text, and the token’s last characters', async () => {
    const { token, hint } = await issueHealthToken(PROJECT, 'production', 'auth0|ada', ISSUED);
    await send(token, { status: 'healthy', sentAt: '2026-11-24T09:59:58Z' });
    const [record] = await listed();
    expect(healthView(record!)).toEqual({
      tokenHint: hint,
      issuedAt: '2026-11-24T09:00:00.000Z',
      status: 'healthy',
      message: null,
      version: null,
      sentAt: '2026-11-24T09:59:58.000Z',
      receivedAt: '2026-11-24T10:00:00.000Z',
      intervalSeconds: null,
      checkins: 1,
    });
  });

  it('where to check in is this Renkei’s address, or nothing when it is not known', () => {
    expect(checkInUrl('https://renkei.example')).toBe('https://renkei.example/api/health/check-in');
    expect(checkInUrl('https://renkei.example/')).toBe(
      'https://renkei.example/api/health/check-in'
    );
    expect(checkInUrl('')).toBeNull();
    expect(checkInUrl('renkei.example')).toBeNull();
    expect(checkInUrl('https://renkei.example/app')).toBeNull();
  });
});
