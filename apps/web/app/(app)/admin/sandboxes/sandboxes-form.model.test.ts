import type { SandboxesView } from '@/lib/sandboxes-admin';
import {
  SUGGESTED_ENV,
  asksEntraAllowed,
  badge,
  canSubmit,
  clientSecretPlaceholder,
  envPlaceholder,
  init,
  orchestratorLine,
  reducer,
  requestBody,
  saveLabel,
  testLabel,
  usesServicePrincipal,
  type SandboxesAction,
  type SandboxesState,
} from './sandboxes-form.model';

const WIRED = { wired: true, reachable: true, provider: 'azure', problem: null };

const STORED: SandboxesView = {
  configured: true,
  enabled: true,
  settings: {
    provider: 'azure',
    callbackUrl: 'https://orchestrator.internal:8097',
    idleSuspendMinutes: 15,
    idleEvictHours: 24,
    azure: {
      subscriptionId: 'bcc23553-20c2-4009-a5e2-ef2740dd125f',
      resourceGroup: 'PRD_INFRA',
      sandboxGroup: 'renkei-sandbox-group',
      region: 'eastus2',
      endpoint: null,
      diskImage: 'renkei-sandbox',
      cpu: '2000m',
      memory: '4096Mi',
      disk: '40Gi',
      suspendMode: 'Memory',
      vnetConnection: 'private',
      portAuth: 'entra',
      entraAllowed: ['orchestrator@contoso.com'],
      allowedCidrs: [],
      tenantId: null,
      clientId: null,
    },
    docker: {
      image: 'renkei-sandbox:latest',
      host: null,
      networks: ['renkei-sandbox'],
      publishHost: null,
      suspend: 'stop',
      nestedEngine: false,
      memoryMb: 4096,
      cpus: 0,
      command: null,
    },
    envNames: ['SANDBOX_ENV_SECRETS_KEY', 'DELEGATE_WORKER_API_KEY'],
  },
  hasAzureClientSecret: false,
  envStored: ['SANDBOX_ENV_SECRETS_KEY', 'DELEGATE_WORKER_API_KEY'],
  orchestrator: WIRED,
};

const run = (start: SandboxesState, ...actions: SandboxesAction[]) =>
  actions.reduce(reducer, start);

describe('the Sandboxes form', () => {
  it('opens a stored setup with its settings and no secret on the page', () => {
    const state = init(STORED);
    expect(state.draft.azure.sandboxGroup).toBe('renkei-sandbox-group');
    expect(state.draft.azure.entraAllowed).toBe('orchestrator@contoso.com');
    expect(state.draft.env).toEqual([
      { name: 'SANDBOX_ENV_SECRETS_KEY', value: '' },
      { name: 'DELEGATE_WORKER_API_KEY', value: '' },
    ]);
    expect(state.draft.azureClientSecret).toBe('');
    expect(badge(state)).toBe('Enabled');
  });

  it('opens empty on Azure, enabled, with the variables a sandbox worker needs waiting to be filled in', () => {
    const state = init(null);
    expect(state.draft.provider).toBe('azure');
    expect(state.draft.enabled).toBe(true);
    expect(state.draft.idleSuspendMinutes).toBe('15');
    expect(state.draft.idleEvictHours).toBe('24');
    expect(state.draft.env.map((row) => row.name)).toEqual(SUGGESTED_ENV);
    // A sandbox has no database access: no database URL is ever asked for.
    expect(SUGGESTED_ENV).not.toContain('DATABASE_URL');
    expect(badge(state)).toBe('Not configured');
  });

  it('a setup switched off says Disabled', () => {
    expect(badge(init({ ...STORED, enabled: false }))).toBe('Disabled');
  });

  it('asks for the allowed identities only with Entra on the worker port', () => {
    const state = init(STORED);
    expect(asksEntraAllowed(state)).toBe(true);
    expect(
      asksEntraAllowed(run(state, { type: 'setAzure', patch: { portAuth: 'anonymous' } }))
    ).toBe(false);
  });

  it('asks for a client secret once a service principal is being named', () => {
    const state = init(STORED);
    expect(usesServicePrincipal(state)).toBe(false);
    expect(
      usesServicePrincipal(run(state, { type: 'setAzure', patch: { clientId: '1111' } }))
    ).toBe(true);
  });

  it('shows a stored secret as stored, to be left blank; one not stored yet as a value to enter', () => {
    const state = init({ ...STORED, hasAzureClientSecret: true });
    expect(envPlaceholder(state, 'SANDBOX_ENV_SECRETS_KEY')).toMatch(/stored; leave blank to keep/);
    expect(envPlaceholder(state, 'NEW_ONE')).toBe('value');
    expect(clientSecretPlaceholder(state)).toMatch(/stored/);
    expect(clientSecretPlaceholder(init(STORED))).toBe('client secret');
  });

  it('adds a variable, names it in capitals as it is typed, takes its value, and removes it', () => {
    const added = run(
      init(STORED),
      { type: 'envAdded' },
      { type: 'envNamed', index: 2, name: 'log-encryption key' },
      { type: 'envValued', index: 2, value: 's3cret' }
    );
    expect(added.draft.env[2]).toEqual({ name: 'LOG_ENCRYPTION_KEY', value: 's3cret' });
    const removed = run(added, { type: 'envRemoved', index: 0 });
    expect(removed.draft.env.map((row) => row.name)).toEqual([
      'DELEGATE_WORKER_API_KEY',
      'LOG_ENCRYPTION_KEY',
    ]);
  });
});

describe('what Save and Test send', () => {
  it('is the whole setup, with a secret only where one was typed', () => {
    const state = run(
      init(STORED),
      { type: 'envValued', index: 1, value: 'new-delegate-key' },
      { type: 'setAzure', patch: { entraAllowed: 'a@contoso.com\n b@contoso.com ' } }
    );
    const body = requestBody(state);
    expect(body).toMatchObject({
      enabled: true,
      provider: 'azure',
      callbackUrl: 'https://orchestrator.internal:8097',
      idleSuspendMinutes: '15',
      idleEvictHours: '24',
      envNames: ['SANDBOX_ENV_SECRETS_KEY', 'DELEGATE_WORKER_API_KEY'],
      envValues: { DELEGATE_WORKER_API_KEY: 'new-delegate-key' },
      azureClientSecret: null,
    });
    expect(body.azure).toMatchObject({
      sandboxGroup: 'renkei-sandbox-group',
      entraAllowed: ['a@contoso.com', 'b@contoso.com'],
      allowedCidrs: [],
    });
  });

  it('leaves out a variable row with no name', () => {
    const body = requestBody(run(init(STORED), { type: 'envAdded' }));
    expect(body.envNames).toEqual(['SANDBOX_ENV_SECRETS_KEY', 'DELEGATE_WORKER_API_KEY']);
  });

  it('sends Docker’s networks as a list', () => {
    const body = requestBody(
      run(
        init(null),
        { type: 'set', patch: { provider: 'docker' } },
        { type: 'setDocker', patch: { networks: 'renkei-sandbox, renkei-sandbox-db' } }
      )
    );
    expect(body.provider).toBe('docker');
    expect(body.docker).toMatchObject({ networks: ['renkei-sandbox', 'renkei-sandbox-db'] });
  });
});

describe('saving and testing', () => {
  it('while saving, both buttons are off and Save reads "Saving…"', () => {
    const state = run(init(STORED), { type: 'sent', what: 'save' });
    expect(canSubmit(state)).toBe(false);
    expect(saveLabel(state)).toBe('Saving…');
    expect(testLabel(state)).toBe('Test connection');
  });

  it('a save adopts the server’s answer, clears the secrets typed, and says "Saved."', () => {
    const answer: SandboxesView = { ...STORED, hasAzureClientSecret: true };
    const state = run(
      init(STORED),
      { type: 'set', patch: { azureClientSecret: 's3cret' } },
      { type: 'envValued', index: 0, value: 'typed-sealing-key' },
      { type: 'sent', what: 'save' },
      { type: 'saved', view: answer }
    );
    expect(state.view).toBe(answer);
    expect(state.draft.azureClientSecret).toBe('');
    expect(state.draft.env[0]).toEqual({ name: 'SANDBOX_ENV_SECRETS_KEY', value: '' });
    expect(state.notice).toBe('Saved.');
    expect(canSubmit(state)).toBe(true);
  });

  it('a refused save keeps what was typed and shows the server’s sentence', () => {
    const state = run(
      init(STORED),
      { type: 'envValued', index: 0, value: 'typed-sealing-key' },
      { type: 'sent', what: 'save' },
      { type: 'failed', message: 'The subscription id is a GUID.' }
    );
    expect(state.error).toBe('The subscription id is a GUID.');
    expect(state.draft.env[0]?.value).toBe('typed-sealing-key');
    expect(canSubmit(state)).toBe(true);
  });

  it('a test that reached the provider says where; one that did not says why, as an error; neither saves', () => {
    const tested = run(init(STORED), { type: 'sent', what: 'test' });
    expect(testLabel(tested)).toBe('Testing…');
    const reached = run(tested, { type: 'tested', ok: true, detail: 'Reached the sandbox group.' });
    expect(reached.notice).toBe('Reached the sandbox group.');
    expect(reached.error).toBeNull();
    const refused = run(tested, { type: 'tested', ok: false, detail: 'AuthorizationFailed' });
    expect(refused.error).toBe('AuthorizationFailed');
    expect(refused.notice).toBeNull();
    expect(refused.view).toBe(STORED);
  });

  it('editing anything clears the last result', () => {
    const state = run(
      init(STORED),
      { type: 'tested', ok: true, detail: 'Reached it.' },
      { type: 'setAzure', patch: { region: 'westus2' } }
    );
    expect(state.notice).toBeNull();
  });
});

describe('the line that says what the orchestrator is doing', () => {
  const line = (orchestrator: SandboxesView['orchestrator']) =>
    orchestratorLine(init({ ...STORED, orchestrator }));

  it('says the setup is in use, and how soon a change takes effect', () => {
    expect(line(WIRED)).toEqual({
      tone: 'ok',
      text: 'The orchestrator is making sandboxes on Azure. A saved change takes effect within a quarter of a minute.',
    });
  });

  it('says why no sandbox can be made, in the orchestrator’s own words', () => {
    expect(
      line({ wired: true, reachable: true, provider: null, problem: 'sandboxes are switched off' })
    ).toEqual({ tone: 'warn', text: 'No sandbox can be made: sandboxes are switched off.' });
  });

  it('says when the orchestrator is not answering', () => {
    expect(line({ wired: true, reachable: false, provider: null, problem: null }).tone).toBe(
      'warn'
    );
  });

  it('says when the deployment runs none, so nothing here is in use', () => {
    const none = line({ wired: false, reachable: false, provider: null, problem: null });
    expect(none.tone).toBe('off');
    expect(none.text).toMatch(/runs no sandbox orchestrator/);
  });
});
