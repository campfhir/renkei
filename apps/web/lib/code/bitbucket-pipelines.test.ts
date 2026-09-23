/**
 * The project page's Pipelines readers and writers against a stubbed
 * BitbucketAuth — the seam the bitbucket_ tool suite and
 * bitbucket-browse.test.ts use. What earns a pin: a secured variable's
 * value is null however Bitbucket answers, the switch is not read when
 * the connection cannot, an environment's variables travel under the
 * deployments_config path, and editing a secured variable with an empty
 * value keeps Bitbucket's rather than blanking it.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import {
  createPipelineVariable,
  deletePipelineVariable,
  readPipelineSetup,
  setPipelinesEnabled,
  updatePipelineVariable,
  validateVariableInput,
} from './bitbucket-pipelines';

interface Route {
  match: string;
  method?: string;
  status?: number;
  body?: unknown;
  text?: string;
}

let routes: Route[] = [];
let calls: { method: string; path: string; scopes: readonly string[]; json?: unknown }[] = [];

const stubAuth: BitbucketAuth = {
  kind: 'pat',
  async fetch(scopes, path, init) {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, scopes, json: init?.json });
    const route = routes.find(
      (candidate) => path.includes(candidate.match) && (candidate.method ?? 'GET') === method
    );
    if (!route) {
      return new Response(JSON.stringify({ error: { message: 'Resource not found' } }), {
        status: 404,
      });
    }
    if (route.status === 204) return new Response(null, { status: 204 });
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  },
};

const REPO = '/repositories/acme/billing-service';

beforeEach(() => {
  routes = [];
  calls = [];
});

describe('readPipelineSetup', () => {
  it('reads the switch, the file, the variables and each environment’s variables', async () => {
    routes = [
      {
        match: `${REPO}/pipelines_config/variables`,
        body: {
          values: [
            { uuid: '{v2}', key: 'NPM_TOKEN', secured: true, value: 'should-never-be-shown' },
            {
              uuid: '{v1}',
              key: 'API_BASE_URL',
              secured: false,
              value: 'https://api.example.test',
            },
          ],
        },
      },
      { match: `${REPO}/pipelines_config`, body: { enabled: true } },
      { match: `${REPO}/src/main/bitbucket-pipelines.yml`, text: 'pipelines:\n  default: []\n' },
      {
        match: `${REPO}/environments`,
        body: {
          values: [
            {
              uuid: '{prod}',
              name: 'Production',
              environment_type: { name: 'Production' },
              rank: 2,
            },
            { uuid: '{test}', name: 'Test', environment_type: { name: 'Test' }, rank: 0 },
          ],
        },
      },
      {
        match: '/deployments_config/environments/%7Bprod%7D/variables',
        body: { values: [{ uuid: '{d1}', key: 'DEPLOY_KEY', secured: true }] },
      },
      { match: '/deployments_config/environments/%7Btest%7D/variables', body: { values: [] } },
    ];
    const read = await readPipelineSetup(stubAuth, 'acme/billing-service', 'main', {
      readSwitch: true,
    });

    expect(read).toEqual({
      ok: true,
      setup: {
        enabled: true,
        enabledError: null,
        configFile: 'present',
        variables: [
          { uuid: '{v1}', key: 'API_BASE_URL', secured: false, value: 'https://api.example.test' },
          // Secured: null whatever Bitbucket put in the field.
          { uuid: '{v2}', key: 'NPM_TOKEN', secured: true, value: null },
        ],
        variablesError: null,
        environments: [
          { uuid: '{test}', name: 'Test', type: 'Test', variables: [], error: null },
          {
            uuid: '{prod}',
            name: 'Production',
            type: 'Production',
            variables: [{ uuid: '{d1}', key: 'DEPLOY_KEY', secured: true, value: null }],
            error: null,
          },
        ],
        environmentsError: null,
      },
    });
    const config = calls.find((call) => call.path === `${REPO}/pipelines_config`);
    expect(config?.scopes).toEqual(['repository:admin']);
  });

  it('leaves the switch unread when told the connection cannot, and reports an absent file', async () => {
    routes = [
      { match: `${REPO}/pipelines_config/variables`, body: { values: [] } },
      { match: `${REPO}/environments`, body: { values: [] } },
    ];
    const read = await readPipelineSetup(stubAuth, 'acme/billing-service', 'main', {
      readSwitch: false,
    });

    expect(read.ok && read.setup.enabled).toBeNull();
    expect(read.ok && read.setup.enabledError).toBeNull();
    expect(read.ok && read.setup.configFile).toBe('absent');
    expect(calls.some((call) => call.path === `${REPO}/pipelines_config`)).toBe(false);
  });

  it('resolves the repository’s main branch when the project names none', async () => {
    routes = [
      { match: `${REPO}/pipelines_config/variables`, body: { values: [] } },
      { match: `${REPO}/pipelines_config`, status: 403, body: { error: { message: 'Forbidden' } } },
      { match: `${REPO}/environments`, body: { values: [] } },
      { match: `${REPO}/src/develop/bitbucket-pipelines.yml`, text: 'pipelines: {}\n' },
      { match: REPO, body: { mainbranch: { name: 'develop' } } },
    ];
    const read = await readPipelineSetup(stubAuth, 'acme/billing-service', '', {
      readSwitch: true,
    });

    expect(read.ok && read.setup.configFile).toBe('present');
    expect(read.ok && read.setup.enabled).toBeNull();
    expect(read.ok && read.setup.enabledError).toMatch(/403: Forbidden/);
  });
});

describe('setPipelinesEnabled', () => {
  it('PUTs the switch on repository:admin', async () => {
    routes = [{ match: `${REPO}/pipelines_config`, method: 'PUT', body: { enabled: true } }];
    const set = await setPipelinesEnabled(stubAuth, 'acme/billing-service', true);

    expect(set).toEqual({ ok: true, enabled: true });
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: `${REPO}/pipelines_config`,
        scopes: ['repository:admin'],
        json: { enabled: true },
      },
    ]);
  });
});

describe('validateVariableInput', () => {
  it('accepts a shell-shaped key and keeps the environment when given', () => {
    expect(
      validateVariableInput({
        key: ' DEPLOY_TOKEN ',
        value: 'x',
        secured: true,
        environmentUuid: '{prod}',
      })
    ).toEqual({
      ok: true,
      input: { key: 'DEPLOY_TOKEN', value: 'x', secured: true, environmentUuid: '{prod}' },
    });
    expect(validateVariableInput({ key: 'plain', value: 'v' })).toEqual({
      ok: true,
      input: { key: 'plain', value: 'v', secured: false },
    });
  });

  it('refuses a key that is not a variable name', () => {
    expect(validateVariableInput({ key: '1ABC', value: '' }).ok).toBe(false);
    expect(validateVariableInput({ key: 'A-B', value: '' }).ok).toBe(false);
    expect(validateVariableInput({ key: '', value: '' }).ok).toBe(false);
  });
});

describe('variable writes', () => {
  it('creates on the repository’s list, or on an environment’s, under pipeline:variable', async () => {
    routes = [
      {
        match: `${REPO}/pipelines_config/variables`,
        method: 'POST',
        body: { uuid: '{v9}', key: 'NPM_TOKEN', secured: true },
      },
      {
        match: '/deployments_config/environments/%7Bprod%7D/variables',
        method: 'POST',
        body: { uuid: '{d9}', key: 'URL', secured: false, value: 'https://prod' },
      },
    ];
    const repo = await createPipelineVariable(stubAuth, 'acme/billing-service', {
      key: 'NPM_TOKEN',
      value: 'secret',
      secured: true,
    });
    const env = await createPipelineVariable(stubAuth, 'acme/billing-service', {
      key: 'URL',
      value: 'https://prod',
      secured: false,
      environmentUuid: '{prod}',
    });

    expect(repo).toEqual({
      ok: true,
      variable: { uuid: '{v9}', key: 'NPM_TOKEN', secured: true, value: null },
    });
    expect(env).toEqual({
      ok: true,
      variable: { uuid: '{d9}', key: 'URL', secured: false, value: 'https://prod' },
    });
    expect(calls.map((call) => [call.method, call.path, call.scopes])).toEqual([
      ['POST', `${REPO}/pipelines_config/variables`, ['pipeline:variable']],
      [
        'POST',
        `${REPO}/deployments_config/environments/%7Bprod%7D/variables`,
        ['pipeline:variable'],
      ],
    ]);
    expect(calls[0].json).toEqual({ key: 'NPM_TOKEN', value: 'secret', secured: true });
  });

  it('keeps a secured variable’s value when the edit sends none', async () => {
    routes = [
      {
        match: `${REPO}/pipelines_config/variables/%7Bv2%7D`,
        method: 'PUT',
        body: { uuid: '{v2}', key: 'NPM_TOKEN_2', secured: true },
      },
    ];
    const updated = await updatePipelineVariable(stubAuth, 'acme/billing-service', 'v2', {
      key: 'NPM_TOKEN_2',
      value: '',
      secured: true,
    });

    expect(updated).toEqual({
      ok: true,
      variable: { uuid: '{v2}', key: 'NPM_TOKEN_2', secured: true, value: null },
    });
    // The bare uuid was brace-wrapped and encoded; no `value` travelled.
    expect(calls[0].path).toBe(`${REPO}/pipelines_config/variables/%7Bv2%7D`);
    expect(calls[0].json).toEqual({ key: 'NPM_TOKEN_2', secured: true });
  });

  it('sends an empty value when a plain variable is emptied on purpose', async () => {
    routes = [
      {
        match: `${REPO}/pipelines_config/variables/%7Bv1%7D`,
        method: 'PUT',
        body: { uuid: '{v1}', key: 'FLAG', secured: false, value: '' },
      },
    ];
    await updatePipelineVariable(stubAuth, 'acme/billing-service', '{v1}', {
      key: 'FLAG',
      value: '',
      secured: false,
    });

    expect(calls[0].json).toEqual({ key: 'FLAG', secured: false, value: '' });
  });

  it('deletes, and renders Bitbucket’s refusal', async () => {
    routes = [
      {
        match: `${REPO}/pipelines_config/variables/%7Bv1%7D`,
        method: 'DELETE',
        status: 204,
        text: '',
      },
      {
        match: '/deployments_config/environments/%7Bprod%7D/variables/%7Bd1%7D',
        method: 'DELETE',
        status: 403,
        body: { error: { message: 'You lack permission' } },
      },
    ];
    const gone = await deletePipelineVariable(stubAuth, 'acme/billing-service', 'v1', undefined);
    const refused = await deletePipelineVariable(stubAuth, 'acme/billing-service', 'd1', 'prod');

    expect(gone).toEqual({ ok: true });
    expect(refused).toEqual({ ok: false, error: 'Bitbucket API 403: You lack permission' });
    expect(calls.map((call) => call.path)).toEqual([
      `${REPO}/pipelines_config/variables/%7Bv1%7D`,
      `${REPO}/deployments_config/environments/%7Bprod%7D/variables/%7Bd1%7D`,
    ]);
  });
});
