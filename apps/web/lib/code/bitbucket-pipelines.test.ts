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
  commitPipelineConfigFile,
  readPipelineConfigFile,
  applyVariableText,
  parseVariableText,
  renderVariableText,
  createPipelineVariable,
  deletePipelineVariable,
  readPipelineSetup,
  setPipelinesEnabled,
  summarize,
  triggerPipeline,
  updatePipelineVariable,
  validateRunInput,
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
        match: `${REPO}/pipelines?`,
        body: {
          values: [
            {
              uuid: '{r2}',
              build_number: 2,
              state: { name: 'IN_PROGRESS', stage: { name: 'RUNNING' } },
              target: { ref_name: 'main' },
              creator: { display_name: 'Dev' },
              created_on: '2026-09-22T10:00:00Z',
            },
            {
              uuid: '{r1}',
              build_number: 1,
              state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
              target: { commit: { hash: '0123456789abcdef' } },
              creator: {},
              created_on: '2026-09-21T10:00:00Z',
              duration_in_seconds: 80,
            },
          ],
        },
      },
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
        runs: [
          {
            uuid: '{r2}',
            buildNumber: 2,
            state: 'RUNNING',
            ref: 'main',
            startedBy: 'Dev',
            createdOn: '2026-09-22T10:00:00Z',
            durationSeconds: null,
            url: 'https://bitbucket.org/acme/billing-service/pipelines/results/2',
          },
          {
            uuid: '{r1}',
            buildNumber: 1,
            state: 'SUCCESSFUL',
            ref: '0123456789ab',
            startedBy: '',
            createdOn: '2026-09-21T10:00:00Z',
            durationSeconds: 80,
            url: 'https://bitbucket.org/acme/billing-service/pipelines/results/1',
          },
        ],
        runsError: null,
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
    const runs = calls.find((call) => call.path.startsWith(`${REPO}/pipelines?`));
    expect(runs?.path).toBe(`${REPO}/pipelines?pagelen=20&sort=-created_on`);
    expect(runs?.scopes).toEqual(['pipeline']);

    // The card's view: counts and the newest run, no names or values.
    expect(read.ok && summarize(read.setup)).toEqual({
      enabled: true,
      enabledError: null,
      configFile: 'present',
      variableCount: 3,
      environmentCount: 2,
      lastRun: read.ok ? read.setup.runs[0] : null,
      runsError: null,
    });
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
    // The runs listing was refused (no route): said, not swallowed.
    expect(read.ok && read.setup.runsError).toMatch(/404/);
    expect(read.ok && summarize(read.setup).variableCount).toBe(0);
    expect(read.ok && summarize(read.setup).lastRun).toBeNull();
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

describe('starting a run', () => {
  it('validates the ref and defaults the type to branch', () => {
    expect(validateRunInput({ ref: ' main ', pattern: '' })).toEqual({
      ok: true,
      input: { ref: 'main', refType: 'branch', pattern: '' },
    });
    expect(validateRunInput({ ref: 'v1.2.0', refType: 'tag', pattern: ' deploy ' })).toEqual({
      ok: true,
      input: { ref: 'v1.2.0', refType: 'tag', pattern: 'deploy' },
    });
    expect(validateRunInput({ ref: '' }).ok).toBe(false);
    expect(validateRunInput({ ref: 'two words' }).ok).toBe(false);
  });

  it('POSTs a ref target on pipeline:write, with a custom selector only when named', async () => {
    routes = [
      {
        match: `${REPO}/pipelines`,
        method: 'POST',
        body: {
          uuid: '{r3}',
          build_number: 3,
          state: { name: 'PENDING', stage: { name: 'PENDING' } },
          target: { ref_name: 'main' },
          creator: { display_name: 'Dev' },
          created_on: '2026-09-23T10:00:00Z',
        },
      },
    ];
    const plain = await triggerPipeline(stubAuth, 'acme/billing-service', {
      ref: 'main',
      refType: 'branch',
      pattern: '',
    });
    const custom = await triggerPipeline(stubAuth, 'acme/billing-service', {
      ref: 'v1',
      refType: 'tag',
      pattern: 'deploy',
    });

    expect(plain).toEqual({
      ok: true,
      run: {
        uuid: '{r3}',
        buildNumber: 3,
        state: 'PENDING',
        ref: 'main',
        startedBy: 'Dev',
        createdOn: '2026-09-23T10:00:00Z',
        durationSeconds: null,
        url: 'https://bitbucket.org/acme/billing-service/pipelines/results/3',
      },
    });
    expect(custom.ok).toBe(true);
    expect(calls.map((call) => [call.method, call.path, call.scopes, call.json])).toEqual([
      [
        'POST',
        `${REPO}/pipelines`,
        ['pipeline:write'],
        { target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main' } },
      ],
      [
        'POST',
        `${REPO}/pipelines`,
        ['pipeline:write'],
        {
          target: {
            type: 'pipeline_ref_target',
            ref_type: 'tag',
            ref_name: 'v1',
            selector: { type: 'custom', pattern: 'deploy' },
          },
        },
      ],
    ]);
  });
});

describe('variables as text', () => {
  it('parses .env lines, YAML-style lines, and the secret prefix, reporting the rest', () => {
    const parsed = parseVariableText(
      [
        '# comment',
        'API_BASE_URL=https://api.example.test',
        'secret NPM_TOKEN=npm_123',
        'SECURED DEPLOY_KEY="with space"',
        'REGION: eu-west-1',
        'export FLAG=1 # trailing',
        'this is broken',
        '1BAD=x',
        'FLAG=2',
      ].join('\n')
    );
    expect(parsed.entries).toEqual([
      { key: 'API_BASE_URL', value: 'https://api.example.test', secured: false },
      { key: 'NPM_TOKEN', value: 'npm_123', secured: true },
      { key: 'DEPLOY_KEY', value: 'with space', secured: true },
      { key: 'REGION', value: 'eu-west-1', secured: false },
      { key: 'FLAG', value: '2', secured: false },
    ]);
    expect(parsed.problems).toEqual([
      'line 7: not a NAME=value line',
      'line 8: not a NAME=value line',
      'line 9: FLAG is given twice; the last one wins',
    ]);
  });

  it('renders a set the way the box shows it, secured ones without a value', () => {
    expect(
      renderVariableText([
        { key: 'API_BASE_URL', value: 'https://api.example.test', secured: false },
        { key: 'NPM_TOKEN', value: null, secured: true },
        { key: 'GREETING', value: 'hello world # not a comment', secured: false },
      ])
    ).toBe(
      'API_BASE_URL=https://api.example.test\nsecret NPM_TOKEN=\nGREETING="hello world # not a comment"'
    );
    // What renders parses back to the same set.
    const back = parseVariableText(
      renderVariableText([{ key: 'G', value: 'a "quoted" \\ value', secured: false }])
    );
    expect(back.entries).toEqual([{ key: 'G', value: 'a "quoted" \\ value', secured: false }]);
  });

  it('applies the difference: creates, replaces, keeps a secured one with no value, deletes', async () => {
    routes = [
      {
        match: `${REPO}/pipelines_config/variables/%7Bplain%7D`,
        method: 'PUT',
        body: { uuid: '{plain}', key: 'API_BASE_URL', secured: false, value: 'v2' },
      },
      {
        match: `${REPO}/pipelines_config/variables/%7Bgone%7D`,
        method: 'DELETE',
        status: 204,
        text: '',
      },
      {
        match: `${REPO}/pipelines_config/variables`,
        method: 'POST',
        body: { uuid: '{new}', key: 'NEW', secured: true },
      },
    ];
    const applied = await applyVariableText(
      stubAuth,
      'acme/billing-service',
      undefined,
      [
        { uuid: '{plain}', key: 'API_BASE_URL', value: 'v1', secured: false },
        { uuid: '{kept}', key: 'NPM_TOKEN', value: null, secured: true },
        { uuid: '{same}', key: 'REGION', value: 'eu', secured: false },
        { uuid: '{gone}', key: 'OLD', value: 'x', secured: false },
      ],
      [
        { key: 'API_BASE_URL', value: 'v2', secured: false },
        { key: 'NPM_TOKEN', value: '', secured: true },
        { key: 'REGION', value: 'eu', secured: false },
        { key: 'NEW', value: 'n', secured: true },
        { key: 'EMPTY_SECRET', value: '', secured: true },
      ]
    );

    expect(applied).toEqual({
      added: ['NEW'],
      changed: ['API_BASE_URL'],
      removed: ['OLD'],
      errors: ['EMPTY_SECRET: a new secured variable needs a value.'],
    });
    // The kept and the unchanged ones made no call at all.
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['PUT', `${REPO}/pipelines_config/variables/%7Bplain%7D`],
      ['POST', `${REPO}/pipelines_config/variables`],
      ['DELETE', `${REPO}/pipelines_config/variables/%7Bgone%7D`],
    ]);
  });
});

describe('the pipeline file', () => {
  it('reads it on the branch, or answers null when there is none', async () => {
    // Both name a branch, so the repository itself is never fetched.
    routes = [{ match: `${REPO}/src/main/bitbucket-pipelines.yml`, text: 'pipelines: {}\n' }];
    const present = await readPipelineConfigFile(stubAuth, 'acme/billing-service', 'main');
    const absent = await readPipelineConfigFile(stubAuth, 'acme/billing-service', 'develop');
    expect(present).toEqual({ ok: true, ref: 'main', text: 'pipelines: {}\n' });
    expect(absent).toEqual({ ok: true, ref: 'develop', text: null });
  });

  it('commits it as the src form post, on the project’s branch, under repository:write', async () => {
    routes = [{ match: `${REPO}/src`, method: 'POST', status: 201, text: '' }];
    const committed = await commitPipelineConfigFile(
      stubAuth,
      'acme/billing-service',
      'main',
      'pipelines: {}\n',
      'Add bitbucket-pipelines.yml'
    );
    expect(committed).toEqual({
      ok: true,
      ref: 'main',
      url: 'https://bitbucket.org/acme/billing-service/src/main/bitbucket-pipelines.yml',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe(`${REPO}/src`);
    expect(calls[0].scopes).toEqual(['repository:write']);
  });

  it('resolves the main branch first when the project names none', async () => {
    routes = [
      { match: `${REPO}/src`, method: 'POST', status: 201, text: '' },
      { match: REPO, body: { mainbranch: { name: 'develop' } } },
    ];
    const committed = await commitPipelineConfigFile(
      stubAuth,
      'acme/billing-service',
      '',
      'pipelines: {}\n',
      'Add'
    );
    expect(committed.ok && committed.ref).toBe('develop');
  });
});
