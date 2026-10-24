/**
 * The Code pages' GitHub readers against a stubbed GitHubAuth — the same
 * seam the github_ tool suite uses. What earns a pin: the README read is
 * ONE call to GitHub's README endpoint (it used to probe the contents
 * endpoint name by name, up to six round trips through the delegate on
 * every project page open), and it falls back to a raw read only when
 * the JSON answer carries no content.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@/lib/get-origin', () => ({ getOrigin: jest.fn() }));

import type { GitHubAuth } from '@/lib/mcp-tools/github/github-auth';
import { readReadme } from './github-browse';

interface Route {
  match: string;
  accept?: string;
  status?: number;
  body?: unknown;
  text?: string;
}

let routes: Route[] = [];
let requests: { path: string; accept: string | undefined }[] = [];

const stubAuth: GitHubAuth = {
  kind: 'oauth',
  async fetch(_scopes, path, init) {
    requests.push({ path, accept: init?.accept });
    const route = routes.find(
      (candidate) =>
        path.includes(candidate.match) &&
        (candidate.accept === undefined || candidate.accept === init?.accept)
    );
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  },
};

beforeEach(() => {
  routes = [];
  requests = [];
});

describe('readReadme', () => {
  it('reads the README in one call to the readme endpoint, on the project branch', async () => {
    routes = [
      {
        match: '/repos/acme/billing/readme?ref=main',
        body: {
          name: 'Readme.rst',
          path: 'docs/Readme.rst',
          encoding: 'base64',
          content: Buffer.from('# Billing\n\nRuns the invoices.\n').toString('base64'),
        },
      },
    ];
    const readme = await readReadme(stubAuth, 'acme/billing', 'main');
    expect(readme).toEqual({ path: 'docs/Readme.rst', text: '# Billing\n\nRuns the invoices.\n' });
    expect(requests.map((request) => request.path)).toEqual([
      '/repos/acme/billing/readme?ref=main',
    ]);
  });

  it('decodes the line-wrapped base64 GitHub sends', async () => {
    const text = 'x'.repeat(200);
    const wrapped = Buffer.from(text)
      .toString('base64')
      .replace(/(.{60})/g, '$1\n');
    routes = [
      {
        match: '/readme',
        body: { name: 'README.md', path: 'README.md', encoding: 'base64', content: wrapped },
      },
    ];
    const readme = await readReadme(stubAuth, 'acme/billing', '');
    expect(readme?.text).toBe(text);
    // No branch given: the endpoint's own default-branch behaviour, no ?ref.
    expect(requests[0]?.path).toBe('/repos/acme/billing/readme');
  });

  it('reads a README too large for the JSON answer raw, in a second call', async () => {
    routes = [
      {
        match: '/readme',
        accept: 'application/vnd.github.raw+json',
        text: '# Big\n',
      },
      {
        match: '/readme',
        body: { name: 'README.md', path: 'README.md', encoding: 'none', content: '' },
      },
    ];
    const readme = await readReadme(stubAuth, 'acme/billing', 'main');
    expect(readme).toEqual({ path: 'README.md', text: '# Big\n' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.accept).toBe('application/vnd.github.raw+json');
  });

  it('answers null, after one call, for a repository without a README', async () => {
    const readme = await readReadme(stubAuth, 'acme/billing', 'main');
    expect(readme).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('answers null for a blank README and for a malformed repository name', async () => {
    routes = [
      {
        match: '/readme',
        body: {
          name: 'README',
          path: 'README',
          encoding: 'base64',
          content: Buffer.from('  \n').toString('base64'),
        },
      },
    ];
    expect(await readReadme(stubAuth, 'acme/billing', 'main')).toBeNull();
    expect(await readReadme(stubAuth, 'acme', 'main')).toBeNull();
  });
});
