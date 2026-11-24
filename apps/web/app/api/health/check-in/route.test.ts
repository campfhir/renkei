/**
 * An application's health check-in (POST /api/health/check-in), on the
 * memory store: no session, only the token issued for one environment;
 * what it answers, what it refuses, and that the token is never written
 * to a log. The rules are lib/ci/health-rules.test.ts.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { issueHealthToken } from '@/lib/ci/health';
import { POST } from './route';

const { logger } = jest.requireMock<{ logger: Record<string, jest.Mock> }>('@/lib/logger');

let projectId: string;
let token: string;

beforeEach(async () => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  projectId = await getDataStore().chatProjects.create({
    ownerSubject: 'owner@example.com',
    name: 'Billing',
    description: null,
    toolConfig: null,
    repo: { provider: 'github', fullName: 'acme/billing', branch: 'main' },
  });
  token = (await issueHealthToken(projectId, 'production', 'owner@example.com', new Date())).token;
});

afterEach(() => resetDataStore());

function checkIn(body: string | object, bearer: string | null = token) {
  return POST(
    new NextRequest('http://test.local/api/health/check-in', {
      method: 'POST',
      headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

describe('POST /api/health/check-in', () => {
  it('takes a check-in made with the environment’s token, and says when the next is expected', async () => {
    const response = await checkIn({ status: 'healthy' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recorded: true,
      environment: 'production',
      status: 'healthy',
      nextCheckInSeconds: 3600,
    });
    const [record] = await getDataStore().ciHealth.listForProject(projectId);
    expect(record).toMatchObject({ status: 'healthy', checkins: 1 });
  });

  it('answers the rhythm the application asked for', async () => {
    const response = await checkIn({ status: 'starting', nextCheckInSeconds: 120 });
    expect(await response.json()).toMatchObject({ status: 'starting', nextCheckInSeconds: 120 });
  });

  it('without a token, or with one Renkei did not issue, is refused', async () => {
    expect((await checkIn({ status: 'healthy' }, null)).status).toBe(401);
    expect((await checkIn({ status: 'healthy' }, 'rkh_someone-elses')).status).toBe(401);
    expect((await checkIn({ status: 'healthy' }, 'not-a-token')).status).toBe(401);
    expect((await getDataStore().ciHealth.listForProject(projectId))[0]?.checkins).toBe(0);
  });

  it('a body that is not JSON, or does not say how it is, is refused', async () => {
    expect((await checkIn('status=healthy')).status).toBe(400);
    expect((await checkIn('')).status).toBe(400);
    const wrong = await checkIn({ status: 'ok' });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe(
      'status is one of starting, healthy, degraded, error, stopping.'
    );
  });

  it('a body far larger than a check-in is refused before it is read', async () => {
    const response = await checkIn({ status: 'healthy', message: 'x'.repeat(9000) });
    expect(response.status).toBe(413);
    expect((await getDataStore().ciHealth.listForProject(projectId))[0]?.checkins).toBe(0);
  });

  it('never writes the token to a log, taken or refused', async () => {
    await checkIn({ status: 'healthy' });
    await checkIn({ status: 'error', message: 'database unreachable' });
    await checkIn({ status: 'nope' });
    await checkIn({ status: 'healthy' }, `${token}x`);
    const logged = JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain(token);
    // The first check-in and the bad news are each worth a line; the refusals a warning.
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('a steady healthy heartbeat is not a line each time', async () => {
    await checkIn({ status: 'healthy' });
    await checkIn({ status: 'healthy' });
    await checkIn({ status: 'healthy' });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
