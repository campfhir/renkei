/**
 * A host that refuses a call is logged with the request it refused, so the
 * refusal can be understood. A call that carries a variable's value is the
 * exception: neither what was sent nor what the host said back (which may
 * quote it) is written down — on either host, and for a plain variable as
 * much as a secret, since which it is is the person's to say.
 */

const warn = jest.fn();
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() },
  // The wrapper that marks a field as sensitive: here it shows what it was given.
  secure: (value: unknown) => value,
}));
jest.mock('@/lib/mcp-tools/common', () => ({
  ...jest.requireActual('@/lib/mcp-tools/common'),
  callerAttrs: jest.fn(async () => ({ caller: 'Ada Lovelace (ada@example.com)' })),
}));

import { bitbucketRequest } from '@/lib/mcp-tools/bitbucket/client';
import { githubRequest } from '@/lib/mcp-tools/github/client';

const VALUE = 'tok-9f2c-not-for-logs';

function refusing(echo: string) {
  const auth = Object.assign(
    async () =>
      new Response(JSON.stringify({ error: { message: `bad value ${echo}` } }), { status: 400 }),
    { grantKey: 'grant:ada' }
  );
  return auth;
}

const logged = () => JSON.stringify(warn.mock.calls);

beforeEach(() => warn.mockClear());

describe('a refused call that carries a variable’s value', () => {
  it('Bitbucket: is logged without its body or the answer', async () => {
    const result = await bitbucketRequest(
      { subject: 'ada@example.com' },
      { auth: refusing(VALUE), accountId: 'a', username: 'ada' },
      '/repositories/acme/app/pipelines_config/variables',
      {
        method: 'POST',
        json: { key: 'DEPLOY_TOKEN', value: VALUE, secured: true },
        withholdBody: true,
      }
    );
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(VALUE);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      status: 400,
      requestBody: 'withheld: it carries a variable’s value',
      responseBody: 'withheld: it carries a variable’s value',
    });
  });

  it('GitHub: is logged without its body or the answer', async () => {
    await githubRequest(
      { subject: 'ada@example.com' },
      { auth: refusing(VALUE), accountId: '1', login: 'ada' },
      '/repos/acme/app/actions/variables',
      { method: 'POST', json: { name: 'API_URL', value: VALUE }, withholdBody: true }
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(VALUE);
  });

  it('any other refused call still says what was sent', async () => {
    await bitbucketRequest(
      { subject: 'ada@example.com' },
      { auth: refusing('x'), accountId: 'a', username: 'ada' },
      '/repositories/acme/app/pullrequests',
      { method: 'POST', json: { title: 'Add the pipeline' } }
    );
    expect(logged()).toContain('Add the pipeline');
  });
});
