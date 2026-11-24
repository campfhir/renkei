/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * A Fabric change as a pull request: the files land in one commit on a new
 * branch from the base, and the pull request goes into the base — on
 * GitHub through the Git data API, on Bitbucket through its src endpoint.
 */

const calls: { method: string; path: string; body: unknown }[] = [];
jest.mock('@/lib/mcp-tools/github/client', () => ({
  ...jest.requireActual('@/lib/mcp-tools/github/client'),
  ghJson: jest.fn(
    async (
      _auth: unknown,
      _scopes: unknown,
      path: string,
      init?: { method?: string; json?: unknown }
    ) => {
      calls.push({ method: init?.method ?? 'GET', path, body: init?.json });
      if (path.endsWith('/git/ref/heads/develop'))
        return { ok: true, body: { object: { sha: 'base-sha' } } };
      if (path.endsWith('/git/commits/base-sha'))
        return { ok: true, body: { tree: { sha: 'base-tree' } } };
      if (path.endsWith('/git/trees')) return { ok: true, body: { sha: 'new-tree' } };
      if (path.endsWith('/git/commits')) return { ok: true, body: { sha: 'new-commit' } };
      if (path.endsWith('/git/refs')) return { ok: true, body: {} };
      if (path.endsWith('/pulls'))
        return { ok: true, body: { html_url: 'https://github.com/acme/sales/pull/9' } };
      return { ok: false, error: 'unexpected' };
    }
  ),
}));
jest.mock('@/lib/code/github-browse', () => ({ githubAuthOf: () => ({}) }));

import { proposalBranch, proposeFiles } from './repo';

const repo = {
  host: 'github' as const,
  project: {
    id: 'p1',
    name: 'Sales repo',
    repo: { provider: 'github', fullName: 'acme/sales', branch: 'main' },
  },
} as unknown as Parameters<typeof proposeFiles>[1];

describe('a Fabric pull request', () => {
  it('names its branch after what it carries and when', () => {
    expect(proposalBranch('Load orders', new Date(Date.UTC(2026, 10, 19, 9, 5)))).toBe(
      'renkei/fabric/load-orders-202611190905'
    );
  });

  it('commits every file once on a new branch from the base, then opens the pull request into it', async () => {
    const proposed = await proposeFiles({ subject: 's', origin: 'https://r.test' }, repo, {
      files: [
        { path: 'fabric/A.Notebook/notebook-content.py', text: '# Fabric notebook source\n' },
        { path: 'fabric/A.Notebook/.platform', text: '{}' },
      ],
      base: 'develop',
      branch: 'renkei/fabric/a-1',
      message: 'Fabric: A (Renkei)',
      title: 'Fabric: A',
      description: 'd',
    });
    expect(proposed).toEqual({
      ok: true,
      branch: 'renkei/fabric/a-1',
      url: 'https://github.com/acme/sales/pull/9',
    });
    expect(calls.map((c) => `${c.method} ${c.path.replace('/repos/acme/sales', '')}`)).toEqual([
      'GET /git/ref/heads/develop',
      'GET /git/commits/base-sha',
      'POST /git/trees',
      'POST /git/commits',
      'POST /git/refs',
      'POST /pulls',
    ]);
    expect(calls[2].body).toMatchObject({
      base_tree: 'base-tree',
      tree: [
        { path: 'fabric/A.Notebook/notebook-content.py' },
        { path: 'fabric/A.Notebook/.platform' },
      ],
    });
    expect(calls[4].body).toEqual({ ref: 'refs/heads/renkei/fabric/a-1', sha: 'new-commit' });
    expect(calls[5].body).toMatchObject({ head: 'renkei/fabric/a-1', base: 'develop' });
  });
});
