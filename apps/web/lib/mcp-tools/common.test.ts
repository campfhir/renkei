/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * jiraFetch over the grant's fetcher.
 *
 * The delegate worker holds the token (docs/delegate-key-design.md): the
 * `AuthedFetch` it hands out attaches the Authorization header, refreshes
 * when due and retries once on a 401. What is left to pin here is the part
 * this process still owns — the headers it sets (and the one it must NOT
 * set), the timeout and reachability errors, and how a refusal the delegate
 * issued itself is told apart from Atlassian's own answer.
 */

jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  secure: (value: unknown) => value,
  redact: (value: unknown) => value,
}));

import { authedFetch } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';
import { jiraFetch, JiraApiError } from './common';

function jsonResponse(status: number, body: unknown = {}, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

function headersOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

const GRANT_KEY = 'atlassian:tenant-1:acct-1';

/** A grant fetcher whose answers the test scripts; `send` records every call. */
function fakeAuth(answer: () => Promise<Response>) {
  const send = jest.fn((_url: string, _init?: RequestInit) => answer());
  return { auth: authedFetch(send, GRANT_KEY), send };
}

afterEach(() => jest.clearAllMocks());

describe('jiraFetch through the grant fetcher', () => {
  it('sends through the AuthedFetch with no Authorization of its own', async () => {
    const { auth, send } = fakeAuth(async () => jsonResponse(200));

    const response = await jiraFetch('https://example.test/rest/api/3/myself', auth);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('https://example.test/rest/api/3/myself');
    const headers = headersOf(send.mock.calls[0]);
    // The delegate attaches the credential; one set here would be dropped anyway.
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe('application/json');
  });

  it('logs the grant behind the call by account, never a token', async () => {
    const { auth } = fakeAuth(async () => jsonResponse(200));

    await jiraFetch('https://example.test/rest/api/3/myself', auth);

    expect(logger.debug).toHaveBeenCalledWith(
      'Request',
      expect.objectContaining({ accountId: 'acct-1' })
    );
  });

  it('persists no request or response body for a successful exchange', async () => {
    const { auth } = fakeAuth(async () =>
      jsonResponse(200, { key: 'X-1', fields: { summary: 's' } })
    );

    await jiraFetch('https://example.test/rest/api/3/issue', auth, {
      method: 'POST',
      body: JSON.stringify({ fields: { summary: 'user content' } }),
    });

    const okLog = (logger.debug as jest.Mock).mock.calls.find(
      ([message]) => message === 'OK response'
    );
    expect(okLog).toBeDefined();
    const attributes: Record<string, unknown> = okLog?.[1] ?? {};
    expect(attributes.status).toBe(200);
    expect(attributes).not.toHaveProperty('requestBody');
    expect(attributes).not.toHaveProperty('responseBody');
  });

  it('still records the bodies of a failed exchange, secure()-marked', async () => {
    const { auth } = fakeAuth(async () => jsonResponse(400, { errorMessages: ['bad field'] }));

    await jiraFetch('https://example.test/rest/api/3/issue', auth, {
      method: 'POST',
      body: JSON.stringify({ fields: {} }),
    }).catch(() => undefined);

    const failLog = (logger.warn as jest.Mock).mock.calls.find(
      ([message]) => message === 'Non-OK response'
    );
    expect(failLog).toBeDefined();
    const attributes: Record<string, unknown> = failLog?.[1] ?? {};
    expect(attributes.requestBody).toBeDefined();
    expect(attributes.responseBody).toBeDefined();
  });

  it('throws a JiraApiError carrying the status on a non-2xx answer', async () => {
    const { auth } = fakeAuth(async () =>
      jsonResponse(404, { errorMessages: ['Issue does not exist'] })
    );

    const failure = await jiraFetch('https://example.test/rest/api/3/issue/X-1', auth).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(JiraApiError);
    expect((failure as JiraApiError).status).toBe(404);
    expect((failure as JiraApiError).message).toContain('Issue does not exist');
    expect((failure as JiraApiError).isAuthError).toBe(false);
  });

  it("treats a 401 as Atlassian's final word — the delegate already retried once", async () => {
    const { auth, send } = fakeAuth(async () => jsonResponse(401));

    const failure = await jiraFetch('https://example.test/rest/api/3/myself', auth).catch(
      (error: unknown) => error
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect((failure as JiraApiError).status).toBe(401);
    expect((failure as JiraApiError).isAuthError).toBe(true);
  });
});

describe('jiraFetch and the delegate’s own refusals', () => {
  it('surfaces a revoked grant as the GRANT_REVOKED auth error callers key on', async () => {
    const { auth } = fakeAuth(async () =>
      jsonResponse(
        401,
        { error: { type: 'GRANT_REVOKED' } },
        { 'x-delegate-error': 'GRANT_REVOKED' }
      )
    );

    const failure = await jiraFetch('https://example.test/rest/api/3/myself', auth).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(JiraApiError);
    expect((failure as JiraApiError).message).toBe('GRANT_REVOKED');
    expect((failure as JiraApiError).isAuthError).toBe(true);
  });

  it('says a missing grant in the resolver’s words, as an auth error', async () => {
    const { auth } = fakeAuth(async () =>
      jsonResponse(404, { error: { type: 'NO_GRANT' } }, { 'x-delegate-error': 'NO_GRANT' })
    );

    const failure = await jiraFetch('https://example.test/rest/api/3/myself', auth).catch(
      (error: unknown) => error
    );

    expect((failure as JiraApiError).message).toContain('Jira is not connected');
    expect((failure as JiraApiError).isAuthError).toBe(true);
  });

  it('reports a host outside Atlassian’s as a refusal, not a Jira answer', async () => {
    const { auth } = fakeAuth(async () =>
      jsonResponse(
        403,
        { error: { type: 'host_not_allowed' } },
        { 'x-delegate-error': 'host_not_allowed' }
      )
    );

    const failure = await jiraFetch('https://evil.test/rest/api/3/myself', auth).catch(
      (error: unknown) => error
    );

    expect((failure as JiraApiError).message).toContain("not Jira's API");
    expect((failure as JiraApiError).isAuthError).toBe(false);
  });
});

describe('jiraFetch FormData bodies', () => {
  it('presets no Content-Type, so fetch can write the multipart boundary', async () => {
    const { auth, send } = fakeAuth(async () => jsonResponse(200));

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hello')]), 'hello.txt');
    await jiraFetch('https://example.test/attachments', auth, {
      method: 'POST',
      body: form,
      headers: { 'X-Atlassian-Token': 'no-check' },
    });

    const headers = headersOf(send.mock.calls[0]);
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['X-Atlassian-Token']).toBe('no-check');
    expect(headers.Authorization).toBeUndefined();
  });

  it('keeps the JSON Content-Type for non-FormData bodies', async () => {
    const { auth, send } = fakeAuth(async () => jsonResponse(200));

    await jiraFetch('https://example.test/rest/api/3/issue', auth, {
      method: 'POST',
      body: JSON.stringify({ fields: {} }),
    });

    expect(headersOf(send.mock.calls[0])['Content-Type']).toBe('application/json');
  });
});

describe('jiraFetch timeouts', () => {
  it('turns a stalled request into a JiraApiError 504 instead of hanging', async () => {
    const { auth } = fakeAuth(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });

    await expect(jiraFetch('https://example.test/rest/api/3/myself', auth)).rejects.toThrow(
      /timed out after \d+ms/
    );
  });

  it('reports an unreachable API as a JiraApiError instead of a raw TypeError', async () => {
    const { auth } = fakeAuth(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(jiraFetch('https://example.test/rest/api/3/myself', auth)).rejects.toThrow(
      'Could not reach the Jira API'
    );
  });
});
