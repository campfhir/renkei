/**
 * The code_pipeline_* tools against a scripted host: a read answers the
 * repository's and each environment's variables with secured ones by name
 * and their values omitted; a write sends only what the plan allows —
 * plain names added or changed, nothing pruned, a secured variable and a
 * secret-looking name left alone — on both hosts, with the person's own
 * grant, and the audit log records keys and never a value.
 */

jest.mock('./access', () => ({
  ...jest.requireActual('./access'),
  grantScopes: jest.fn(),
}));
jest.mock('./github-browse', () => ({ githubAuthOf: jest.fn() }));
jest.mock('./bitbucket-browse', () => ({ bitbucketAuthOf: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { pipelineVariableTools } from './pipeline-tools';
import type { LocalToolContext } from '@/lib/chat/local-tools';
import { resourceCipher } from '@/lib/chat/content-crypto';

const access = jest.requireMock<{ grantScopes: jest.Mock }>('./access');
const github = jest.requireMock<{ githubAuthOf: jest.Mock }>('./github-browse');
const bitbucket = jest.requireMock<{ bitbucketAuthOf: jest.Mock }>('./bitbucket-browse');
const audit = jest.requireMock<{ recordAuditEvent: jest.Mock }>('@/lib/audit-events');

const context: LocalToolContext = {
  subject: 'auth0|alice',
  chatId: 'chat-1',
  cipher: resourceCipher({ id: '00000000-0000-4000-8000-00000000c1fe', key: Buffer.alloc(32, 7) }),
  projectId: 'p1',
  userEmail: 'alice@example.com',
  readOnly: false,
};

interface Call {
  method: string;
  path: string;
  json?: unknown;
}

/** A scripted host: answers by method and path, and records every call it gets. */
function host(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = jest.fn(
    async (
      _scopes: readonly string[],
      path: string,
      init?: { method?: string; json?: unknown }
    ) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path, ...(init?.json !== undefined ? { json: init.json } : {}) });
      const key = `${method} ${path.split('?')[0]}`;
      const body = answers[key];
      if (body === undefined)
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }
  );
  return { fetch, calls, kind: 'oauth' as const };
}

function tool(provider: string, name: string) {
  const found = pipelineVariableTools({
    repoProvider: provider,
    repoFullName: 'acme/demo',
    origin: 'https://r.example',
  }).find((entry) => entry.def.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const text = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? '';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('on GitHub', () => {
  const answers = {
    'GET /repos/acme/demo/actions/variables': {
      variables: [{ name: 'REGION', value: 'eu' }],
    },
    'GET /repos/acme/demo/actions/secrets': { secrets: [{ name: 'DEPLOY_TOKEN' }] },
    'GET /repos/acme/demo/environments': { environments: [{ name: 'production' }] },
    'GET /repos/acme/demo/environments/production/variables': {
      variables: [{ name: 'API_URL', value: 'https://api.test' }],
    },
    'GET /repos/acme/demo/environments/production/secrets': { secrets: [] },
  };

  it('reads the sets, a secret by name with its value omitted', async () => {
    access.grantScopes.mockResolvedValue(['actions:configure']);
    github.githubAuthOf.mockReturnValue(host(answers));
    const result = await tool('github', 'code_pipeline_variables').execute({}, context);
    expect(text(result)).toBe(
      [
        'Repository variables:',
        '  REGION=eu',
        '  DEPLOY_TOKEN — secured, value omitted',
        '',
        'Environment “production” variables:',
        '  API_URL=https://api.test',
      ].join('\n')
    );
  });

  it('says what the connection lacks, in the Connectors page’s words, before asking GitHub', async () => {
    access.grantScopes.mockResolvedValue(['actions']);
    const auth = host(answers);
    github.githubAuthOf.mockReturnValue(auth);
    const result = await tool('github', 'code_pipeline_variables').execute({}, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not carry “Configure Actions”/);
    expect(auth.calls).toEqual([]);
  });

  it('adds and changes what it names, never prunes, and leaves a secret-looking name alone', async () => {
    access.grantScopes.mockResolvedValue(['actions:configure']);
    const auth = host({
      ...answers,
      'POST /repos/acme/demo/actions/variables': {},
      'PATCH /repos/acme/demo/actions/variables/REGION': {},
    });
    github.githubAuthOf.mockReturnValue(auth);
    const result = await tool('github', 'code_pipeline_set_variables').execute(
      { variables: { REGION: 'us', STAGE: 'prod', NPM_TOKEN: 'abc' } },
      context
    );
    expect(auth.calls.filter((call) => call.method !== 'GET')).toEqual([
      {
        method: 'PATCH',
        path: '/repos/acme/demo/actions/variables/REGION',
        json: { name: 'REGION', value: 'us' },
      },
      {
        method: 'POST',
        path: '/repos/acme/demo/actions/variables',
        json: { name: 'STAGE', value: 'prod' },
      },
    ]);
    expect(text(result)).toMatch(/added STAGE; changed REGION\./);
    expect(text(result)).toMatch(/Left alone: NPM_TOKEN reads as a secret/);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'code.actions.variables.replaced',
        details: expect.objectContaining({ via: 'chat', added: ['STAGE'], changed: ['REGION'] }),
      })
    );
    expect(JSON.stringify(audit.recordAuditEvent.mock.calls)).not.toContain('prod"');
  });

  it('will not remove a secret, and removes a plain variable by name', async () => {
    access.grantScopes.mockResolvedValue(['actions:configure']);
    const auth = host({ ...answers, 'DELETE /repos/acme/demo/actions/variables/REGION': {} });
    github.githubAuthOf.mockReturnValue(auth);
    const result = await tool('github', 'code_pipeline_set_variables').execute(
      { remove: ['REGION', 'DEPLOY_TOKEN'] },
      context
    );
    expect(auth.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
      '/repos/acme/demo/actions/variables/REGION',
    ]);
    expect(text(result)).toMatch(/removed REGION\./);
    expect(text(result)).toMatch(/DEPLOY_TOKEN is secured/);
  });

  it('refuses a write in read-only mode', async () => {
    const result = await tool('github', 'code_pipeline_set_variables').execute(
      { variables: { A: 'b' } },
      { ...context, readOnly: true }
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/read-only/);
  });
});

describe('on Bitbucket', () => {
  const answers = {
    'GET /repositories/acme/demo/pipelines_config/variables': {
      values: [
        { uuid: '{1}', key: 'REGION', value: 'eu', secured: false },
        { uuid: '{2}', key: 'DEPLOY_KEY', secured: true },
      ],
    },
    'GET /repositories/acme/demo/environments': {
      values: [{ uuid: '{e1}', name: 'Production', rank: 1 }],
    },
    'GET /repositories/acme/demo/deployments_config/environments/%7Be1%7D/variables': {
      values: [{ uuid: '{3}', key: 'API_URL', value: 'https://api.test', secured: false }],
    },
  };

  it('reads the sets, a secured variable by name with its value omitted', async () => {
    access.grantScopes.mockResolvedValue(['pipeline']);
    bitbucket.bitbucketAuthOf.mockReturnValue(host(answers));
    const result = await tool('atlassian-bitbucket', 'code_pipeline_variables').execute(
      {},
      context
    );
    expect(text(result)).toBe(
      [
        'Repository variables:',
        '  DEPLOY_KEY — secured, value omitted',
        '  REGION=eu',
        '',
        'Environment “Production” variables:',
        '  API_URL=https://api.test',
      ].join('\n')
    );
  });

  it('writes one environment’s set by its name, only adding and changing what it names', async () => {
    access.grantScopes.mockResolvedValue(['pipeline', 'pipeline:variable']);
    const auth = host({
      ...answers,
      'POST /repositories/acme/demo/deployments_config/environments/%7Be1%7D/variables': {
        uuid: '{4}',
        key: 'STAGE',
        value: 'prod',
        secured: false,
      },
    });
    bitbucket.bitbucketAuthOf.mockReturnValue(auth);
    const result = await tool('atlassian-bitbucket', 'code_pipeline_set_variables').execute(
      { environment: 'Production', variables: { STAGE: 'prod' } },
      context
    );
    expect(auth.calls.filter((call) => call.method !== 'GET')).toEqual([
      {
        method: 'POST',
        path: '/repositories/acme/demo/deployments_config/environments/%7Be1%7D/variables',
        json: { key: 'STAGE', value: 'prod', secured: false },
      },
    ]);
    expect(text(result)).toMatch(/added STAGE\./);
  });

  it('will not overwrite a secured variable', async () => {
    access.grantScopes.mockResolvedValue(['pipeline', 'pipeline:variable']);
    const auth = host(answers);
    bitbucket.bitbucketAuthOf.mockReturnValue(auth);
    const result = await tool('atlassian-bitbucket', 'code_pipeline_set_variables').execute(
      { variables: { DEPLOY_KEY: 'x' } },
      context
    );
    expect(auth.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(text(result)).toMatch(/Nothing was written\.[\s\S]*DEPLOY_KEY is secured/);
  });
});

it('offers nothing for a host with no pipelines', () => {
  expect(
    pipelineVariableTools({ repoProvider: 'gitlab', repoFullName: 'a/b', origin: '' })
  ).toEqual([]);
});
