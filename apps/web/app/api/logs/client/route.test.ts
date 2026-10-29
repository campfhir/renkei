/**
 * The browser's log lines are written under the session's subject, never
 * one the body names, and only for a signed-in caller.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { NextRequest } from 'next/server';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { logger } = jest.requireMock<{
  logger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock };
}>('@/lib/logger');

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/logs/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const line = {
  level: 'error',
  component: 'fetch',
  message: 'POST /api/chat/attachments/ocr failed (500)',
  page: '/chat/c1',
  attrs: { status: 500, subject: 'someone-else' },
};

beforeEach(() => {
  jest.clearAllMocks();
  resetInboundLimits();
});

it('refuses a caller with no session', async () => {
  mockGetSession.mockResolvedValue(null);
  const response = await POST(request(line));
  expect(response.status).toBe(401);
  expect(logger.error).not.toHaveBeenCalled();
});

it('logs the line under the session subject with a client/ component', async () => {
  mockGetSession.mockResolvedValue({ subject: 'sub-a', roles: ['renkei-user'] });
  const response = await POST(request(line));
  expect(response.status).toBe(200);
  expect(logger.error).toHaveBeenCalledWith(
    'POST /api/chat/attachments/ocr failed (500)',
    expect.objectContaining({ component: 'client/fetch', subject: 'sub-a', status: 500, page: '/chat/c1' })
  );
});

it('refuses a malformed line', async () => {
  mockGetSession.mockResolvedValue({ subject: 'sub-a', roles: ['renkei-user'] });
  const response = await POST(request({ level: 'loud', message: 'x', component: 'y' }));
  expect(response.status).toBe(400);
});

it('rate limits one person', async () => {
  mockGetSession.mockResolvedValue({ subject: 'sub-b', roles: ['renkei-user'] });
  let last = 200;
  for (let i = 0; i < 61; i++) last = (await POST(request(line))).status;
  expect(last).toBe(429);
});
