/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The bitbucket_ tools against a stubbed BitbucketAuth — the same seam the
 * JSM suite uses. What earns a pin here: the wire bodies Bitbucket is
 * strict about (branch targets, reviewer uuids, inline comments, pipeline
 * selectors, the form-encoded src commit), the preview tools never
 * performing the act they preview, the partial-update merge on PRs (the
 * PUT demands a title even for a description-only edit), and the scope
 * gate registering exactly the families the connection carries.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// pullrequests.ts imports helpers from ../common, which transitively pulls
// in @renkei/db (ESM-only kysely) for exports this suite never touches.
jest.mock('../common', () => ({
  withPresentationHint: (text: string) => text,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerBitbucketTools } from './index';
import type { BitbucketAuth } from './bitbucket-auth';
import { bitbucketScopeFor } from './scopes';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface Route {
  match: string;
  method?: string;
  status?: number;
  body?: unknown;
  /** Raw text response (diffs, file reads, logs). */
  text?: string;
}

let routes: Route[] = [];
let requests: { path: string; method: string; json: unknown; form: string | null }[] = [];

const stubAuth: BitbucketAuth = {
  kind: 'pat',
  async fetch(_scopes, path, init) {
    const method = init?.method ?? 'GET';
    requests.push({
      path,
      method,
      json: init?.json,
      form: init?.form ? init.form.toString() : null,
    });
    const route = routes.find(
      (candidate) =>
        path.includes(candidate.match) && (candidate.method ?? method) === method
    );
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  },
};

async function toolsOf(scopes?: string[]): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    bitbucketScopes: scopes,
  } as unknown as MCPToolContext;
  await registerBitbucketTools(server, context, stubAuth);
  return registered;
}

beforeEach(() => {
  routes = [];
  requests = [];
});

describe('scope-gated registration', () => {
  it('registers every tool when no scopes are recorded (legacy grants)', async () => {
    const tools = await toolsOf(undefined);
    expect(tools.has('bitbucket_list_repositories')).toBe(true);
    expect(tools.has('bitbucket_merge_pull_request')).toBe(true);
    expect(tools.has('bitbucket_trigger_pipeline')).toBe(true);
  });

  it('a repository-read connection gets no writes and no other families', async () => {
    const tools = await toolsOf(['repository', 'project', 'account']);
    expect(tools.has('bitbucket_list_repositories')).toBe(true);
    expect(tools.has('bitbucket_read_file')).toBe(true);
    expect(tools.has('bitbucket_list_workspaces')).toBe(true);
    expect(tools.has('bitbucket_create_branch')).toBe(false);
    expect(tools.has('bitbucket_list_pull_requests')).toBe(false);
    expect(tools.has('bitbucket_trigger_pipeline')).toBe(false);
  });

  it('PR comment/task acts stand on pullrequest:write, stricter than the API', async () => {
    // Bitbucket itself would take these with `pullrequest` — a read-narrowed
    // connection must stay read-only here regardless.
    const tools = await toolsOf(['pullrequest']);
    expect(tools.has('bitbucket_list_pr_comments')).toBe(true);
    expect(tools.has('bitbucket_add_pr_comment')).toBe(false);
    expect(tools.has('bitbucket_add_pr_task')).toBe(false);
    expect(tools.has('bitbucket_resolve_pr_comment')).toBe(false);
  });

  it('every registered tool has a real scope mapping', async () => {
    const tools = await toolsOf(undefined);
    const unmapped = [...tools.keys()].filter((name) =>
      bitbucketScopeFor(name).includes('__unmapped__')
    );
    expect(unmapped).toEqual([]);
  });
});

describe('pull requests', () => {
  it('creates a PR with branch objects and brace-wrapped reviewer uuids', async () => {
    routes = [
      {
        match: '/pullrequests',
        method: 'POST',
        body: {
          id: 7,
          title: 'Add rate limiting',
          source: { branch: { name: 'feature/rl' } },
          destination: { branch: { name: 'main' } },
        },
      },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_create_pull_request')!({
      workspace: 'acme',
      repoSlug: 'api',
      title: 'Add rate limiting',
      sourceBranch: 'feature/rl',
      destinationBranch: 'main',
      closeSourceBranch: true,
      reviewers: ['1111-2222', '{3333-4444}'],
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('#7');
    expect(result.content[0]?.text).toContain('https://bitbucket.org/acme/api/pull-requests/7');
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toMatchObject({
      title: 'Add rate limiting',
      source: { branch: { name: 'feature/rl' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: true,
      reviewers: [{ uuid: '{1111-2222}' }, { uuid: '{3333-4444}' }],
    });
  });

  it('the create preview never creates — the card does', async () => {
    routes = [
      { match: '/repositories/acme/api', body: { mainbranch: { name: 'main' } } },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_create_pull_request_preview')!({
      workspace: 'acme',
      repoSlug: 'api',
      title: 'Add rate limiting',
      sourceBranch: 'feature/rl',
    });

    expect(result.isError).not.toBe(true);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      kind: 'issue',
      confirmTool: 'bitbucket_create_pull_request_confirm',
    });
    // The real destination the merge would use, read from the repository.
    const fields = result.structuredContent?.fields as { label: string; value: string }[];
    expect(fields).toContainEqual({ label: 'Destination', value: 'main' });
  });

  it('a description-only update keeps the current title (the PUT demands one)', async () => {
    routes = [
      {
        match: '/pullrequests/7',
        method: 'GET',
        body: { id: 7, title: 'Original title', description: 'old' },
      },
      { match: '/pullrequests/7', method: 'PUT', body: { id: 7 } },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_update_pull_request')!({
      workspace: 'acme',
      repoSlug: 'api',
      id: 7,
      description: 'New description',
    });

    expect(result.isError).not.toBe(true);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.json).toMatchObject({ title: 'Original title', description: 'New description' });
  });

  it('the merge preview never merges — the card does', async () => {
    routes = [
      {
        match: '/pullrequests/7',
        method: 'GET',
        body: {
          id: 7,
          title: 'Add rate limiting',
          source: { branch: { name: 'feature/rl' } },
          destination: { branch: { name: 'main' } },
          participants: [{ role: 'REVIEWER', approved: true, user: { display_name: 'Evan' } }],
        },
      },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_merge_pull_request_preview')!({
      workspace: 'acme',
      repoSlug: 'api',
      id: 7,
    });

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      confirmTool: 'bitbucket_merge_pull_request_confirm',
    });
    const fields = result.structuredContent?.fields as { label: string; value: string }[];
    expect(fields).toContainEqual({ label: 'Approvals', value: '1' });
  });

  it('merges with the chosen strategy', async () => {
    routes = [{ match: '/merge', method: 'POST', body: { id: 7, state: 'MERGED' } }];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_merge_pull_request')!({
      workspace: 'acme',
      repoSlug: 'api',
      id: 7,
      strategy: 'squash',
    });

    expect(result.isError).not.toBe(true);
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toMatchObject({ merge_strategy: 'squash' });
    expect(result.content[0]?.text).toContain('Merged pull request #7');
  });

  it('an inline comment carries its file and line', async () => {
    routes = [{ match: '/comments', method: 'POST', body: { id: 99 } }];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_add_pr_comment')!({
      workspace: 'acme',
      repoSlug: 'api',
      id: 7,
      comment: 'Off-by-one here.',
      path: 'src/limiter.ts',
      line: 42,
    });

    expect(result.isError).not.toBe(true);
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toMatchObject({
      content: { raw: 'Off-by-one here.' },
      inline: { path: 'src/limiter.ts', to: 42 },
    });
  });

  it('the anonymous 404 names both readings, not just "wrong URL"', async () => {
    // Bitbucket hides auth-gated endpoints from requests it treats as
    // anonymous: a missing or EMPTY Authorization header gets this exact
    // "Resource not found" 404 on endpoints that exist (a bad token gets
    // 401). Rendered as-is it reads like a wrong URL and sends the
    // debugging in exactly the wrong direction — the regression this pins.
    routes = [
      {
        match: '/workspaces',
        status: 404,
        body: {
          type: 'error',
          error: {
            message: 'Resource not found',
            detail: 'There is no API hosted at this URL.',
          },
        },
      },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_list_workspaces')!({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('without usable credentials');
  });

  it('an API rejection surfaces Bitbucket’s own message', async () => {
    routes = [
      {
        match: '/pullrequests',
        method: 'POST',
        status: 400,
        body: { error: { message: 'source branch not found' } },
      },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_create_pull_request')!({
      workspace: 'acme',
      repoSlug: 'api',
      title: 'x',
      sourceBranch: 'missing',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('source branch not found');
  });
});

describe('repositories and source', () => {
  it('creates a branch at a target hash', async () => {
    routes = [
      {
        match: '/refs/branches',
        method: 'POST',
        body: { name: 'fix/timeout', target: { hash: 'abc123def456' } },
      },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_create_branch')!({
      workspace: 'acme',
      repoSlug: 'api',
      name: 'fix/timeout',
      target: 'main',
    });

    expect(result.isError).not.toBe(true);
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toEqual({ name: 'fix/timeout', target: { hash: 'main' } });
    expect(result.content[0]?.text).toContain('Created branch fix/timeout');
  });

  it('commits a file through the form-encoded src endpoint', async () => {
    routes = [{ match: '/src', method: 'POST', status: 201, text: '' }];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_commit_file')!({
      workspace: 'acme',
      repoSlug: 'api',
      branch: 'main',
      path: 'docs/README.md',
      content: '# Hello',
      message: 'Add readme',
    });

    expect(result.isError).not.toBe(true);
    const post = requests.find((request) => request.method === 'POST');
    const form = new URLSearchParams(post?.form ?? '');
    expect(form.get('docs/README.md')).toBe('# Hello');
    expect(form.get('message')).toBe('Add readme');
    expect(form.get('branch')).toBe('main');
  });

  it('renders a diff as raw text and says when it was truncated', async () => {
    routes = [{ match: '/diff/', text: 'x'.repeat(60_001) }];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_get_diff')!({
      workspace: 'acme',
      repoSlug: 'api',
      spec: 'feature..main',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('diff truncated');
  });

  it('says when a listing has further pages', async () => {
    routes = [
      {
        match: '/pullrequests',
        body: {
          next: 'https://api.bitbucket.org/2.0/…page=2',
          values: [
            {
              id: 1,
              title: 'One',
              state: 'OPEN',
              source: { branch: { name: 'a' } },
              destination: { branch: { name: 'main' } },
              author: { display_name: 'Scott' },
            },
          ],
        },
      },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_list_pull_requests')!({
      workspace: 'acme',
      repoSlug: 'api',
    });

    expect(result.content[0]?.text).toContain('#1 One [OPEN]');
    expect(result.content[0]?.text).toContain('More exist');
  });
});

describe('pipelines', () => {
  it('triggers the default pipeline on a branch', async () => {
    routes = [
      { match: '/pipelines', method: 'POST', body: { build_number: 12, uuid: '{p-1}' } },
    ];
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_trigger_pipeline')!({
      workspace: 'acme',
      repoSlug: 'api',
      ref: 'main',
    });

    expect(result.isError).not.toBe(true);
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toEqual({
      target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main' },
    });
    expect(result.content[0]?.text).toContain('#12');
  });

  it('a custom pipeline travels as a selector', async () => {
    routes = [
      { match: '/pipelines', method: 'POST', body: { build_number: 13, uuid: '{p-2}' } },
    ];
    const tools = await toolsOf();
    await tools.get('bitbucket_trigger_pipeline')!({
      workspace: 'acme',
      repoSlug: 'api',
      ref: 'main',
      pattern: 'deploy-staging',
    });

    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toMatchObject({
      target: { selector: { type: 'custom', pattern: 'deploy-staging' } },
    });
  });

  it('the trigger preview never triggers — the card does', async () => {
    const tools = await toolsOf();
    const result = await tools.get('bitbucket_trigger_pipeline_preview')!({
      workspace: 'acme',
      repoSlug: 'api',
      ref: 'main',
    });

    expect(requests).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      confirmTool: 'bitbucket_trigger_pipeline_confirm',
    });
  });

  it('normalizes bare uuids into brace form for pipeline paths', async () => {
    routes = [{ match: '/steps', body: { values: [] } }, { match: '/pipelines/', body: {} }];
    const tools = await toolsOf();
    await tools.get('bitbucket_get_pipeline')!({
      workspace: 'acme',
      repoSlug: 'api',
      pipelineUuid: 'abc-123',
    });

    expect(requests[0]?.path).toContain(encodeURIComponent('{abc-123}'));
  });
});
