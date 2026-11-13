import {
  AZURE_CLIENT_SECRET_KEY,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  mergeOrchestratorSecrets,
  orchestratorSettingsOfRow,
  orchestratorTemplateEnv,
  orchestratorViewOfRow,
  parseOrchestratorInput,
  type OrchestratorInput,
} from './orchestrator-config';

const AZURE = {
  subscriptionId: 'bcc23553-20c2-4009-a5e2-ef2740dd125f',
  resourceGroup: 'PRD_INFRA',
  sandboxGroup: 'renkei-sandbox-group',
  region: 'eastus2',
  diskImage: 'renkei-sandbox',
  entraAllowed: ['orchestrator@contoso.com'],
};

const form = (overrides: Record<string, unknown> = {}) => ({
  provider: 'azure',
  callbackUrl: 'https://orchestrator.internal:8097/',
  azure: AZURE,
  envNames: ['DELEGATE_WORKER_API_KEY'],
  envValues: { DELEGATE_WORKER_API_KEY: 'delegate-key' },
  ...overrides,
});

function parsed(body: unknown): OrchestratorInput {
  const input = parseOrchestratorInput(body);
  if (typeof input === 'string') throw new Error(`expected a valid form, got: ${input}`);
  return input;
}

describe('the sandbox setup an operator saves', () => {
  it('is an Azure sandbox group, with the sizes and idle rules filled in when not given', () => {
    const input = parsed(form());
    expect(input.enabled).toBe(true);
    expect(input.settings.provider).toBe('azure');
    expect(input.settings.azure).toMatchObject({
      ...AZURE,
      cpu: '2000m',
      memory: '4096Mi',
      disk: '40Gi',
      suspendMode: 'Memory',
      portAuth: 'entra',
    });
    expect(input.settings.idleSuspendMinutes).toBe(15);
    expect(input.settings.idleEvictHours).toBe(24);
    expect(input.envValues).toEqual({ DELEGATE_WORKER_API_KEY: 'delegate-key' });
    expect(input.settings.callbackUrl).toBe('https://orchestrator.internal:8097');
  });

  it('or a Docker engine, which needs none of the Azure fields', () => {
    const input = parsed({
      provider: 'docker',
      callbackUrl: 'http://renkei-worker-orchestrator:8097',
      docker: { image: 'renkei-sandbox:dev' },
    });
    expect(input.settings.docker).toMatchObject({
      image: 'renkei-sandbox:dev',
      networks: ['renkei-sandbox'],
      suspend: 'stop',
      nestedEngine: false,
    });
  });

  it.each([
    [{ provider: 'kubernetes' }, /Azure or Docker/],
    [{ callbackUrl: '' }, /address sandboxes reach the orchestrator/],
    [{ callbackUrl: 'orchestrator:8097' }, /address sandboxes reach the orchestrator/],
    [{ azure: { ...AZURE, subscriptionId: 'prod' } }, /subscription id is a GUID/],
    [{ azure: { ...AZURE, sandboxGroup: '' } }, /sandbox group/],
    [{ azure: { ...AZURE, region: 'East US 2' } }, /region/],
    [{ azure: { ...AZURE, diskImage: '' } }, /disk image/],
    [{ azure: { ...AZURE, cpu: '2 cores' } }, /millicores/],
    [{ azure: { ...AZURE, memory: '4GB' } }, /Memory/],
    [{ azure: { ...AZURE, entraAllowed: [] } }, /name the identity/],
    [{ azure: { ...AZURE, entraAllowed: ['not-an-identity'] } }, /email address/],
    [{ azure: { ...AZURE, allowedCidrs: ['office'] } }, /CIDR/],
    [
      { azure: { ...AZURE, tenantId: 'bcc23553-20c2-4009-a5e2-ef2740dd125f' } },
      /both its tenant id and its client id/,
    ],
    [{ idleSuspendMinutes: 0 }, /Suspend after/],
    [{ idleSuspendMinutes: 120, idleEvictHours: 1 }, /evicted later/],
    [{ envNames: ['database-url'] }, /not a variable name/],
  ])('refuses %j with a sentence saying what is wrong', (overrides, message) => {
    expect(parseOrchestratorInput(form(overrides))).toMatch(message);
  });

  it('with the worker port left to the sandbox’s own key needs nobody named', () => {
    const input = parsed(form({ azure: { ...AZURE, portAuth: 'anonymous', entraAllowed: [] } }));
    expect(input.settings.azure.portAuth).toBe('anonymous');
  });

  it('never hands a sandbox a database URL: a sandbox has no database access', () => {
    expect(parseOrchestratorInput(form({ envNames: ['DATABASE_URL'] }))).toMatch(
      /a sandbox has no database access/
    );
  });

  it.each(['TOKEN_ENCRYPTION_KEY', 'CONTENT_ENCRYPTION_KEY', 'SANDBOX_WORKER_API_KEY'])(
    'never hands a sandbox %s',
    (name) => {
      expect(parseOrchestratorInput(form({ envNames: [name] }))).toMatch(
        /cannot be handed to a sandbox/
      );
    }
  );

  it('takes lists typed as text, one per line or comma-separated', () => {
    const input = parsed(
      form({
        azure: { ...AZURE, entraAllowed: 'a@contoso.com, b@contoso.com\nA@contoso.com' },
        envNames: 'LOG_ENCRYPTION_KEY\nDELEGATE_WORKER_URL',
        envValues: { LOG_ENCRYPTION_KEY: 'x', DELEGATE_WORKER_URL: 'y' },
      })
    );
    expect(input.settings.azure.entraAllowed).toEqual([
      'a@contoso.com',
      'b@contoso.com',
      'A@contoso.com',
    ]);
    expect(input.settings.envNames).toEqual(['LOG_ENCRYPTION_KEY', 'DELEGATE_WORKER_URL']);
  });
});

describe('its secrets', () => {
  it('are what was typed, laid over what is stored: a blank keeps, a variable no longer named is dropped', () => {
    const input = parsed(
      form({
        envNames: ['SANDBOX_ENV_SECRETS_KEY', 'DELEGATE_WORKER_API_KEY'],
        envValues: { DELEGATE_WORKER_API_KEY: 'new-key' },
      })
    );
    expect(
      mergeOrchestratorSecrets(input, {
        'env.SANDBOX_ENV_SECRETS_KEY': 'stored-sealing-key',
        'env.DELEGATE_WORKER_API_KEY': 'old-key',
        'env.GONE': 'x',
        [AZURE_CLIENT_SECRET_KEY]: 'stored-secret',
      })
    ).toEqual({
      'env.SANDBOX_ENV_SECRETS_KEY': 'stored-sealing-key',
      'env.DELEGATE_WORKER_API_KEY': 'new-key',
      [AZURE_CLIENT_SECRET_KEY]: 'stored-secret',
    });
  });

  it('must include a value for every variable named, and the client secret of a service principal', () => {
    expect(mergeOrchestratorSecrets(parsed(form({ envValues: {} })), {})).toBe(
      'Enter a value for DELEGATE_WORKER_API_KEY.'
    );
    const principal = parsed(
      form({
        azure: {
          ...AZURE,
          tenantId: 'bcc23553-20c2-4009-a5e2-ef2740dd125f',
          clientId: '11111111-2222-4333-8444-555555555555',
        },
      })
    );
    expect(mergeOrchestratorSecrets(principal, {})).toMatch(/client secret/);
    expect(
      mergeOrchestratorSecrets({ ...principal, azureClientSecret: 's3cret' }, {})
    ).toMatchObject({ [AZURE_CLIENT_SECRET_KEY]: 's3cret' });
  });

  it('become each sandbox’s environment under the variables’ own names', () => {
    const settings = {
      ...DEFAULT_ORCHESTRATOR_SETTINGS,
      envNames: ['SANDBOX_ENV_SECRETS_KEY', 'MISSING'],
    };
    expect(
      orchestratorTemplateEnv(settings, {
        'env.SANDBOX_ENV_SECRETS_KEY': 'sealing-key-value',
        'env.UNLISTED': 'x',
        [AZURE_CLIENT_SECRET_KEY]: 'never an env value',
      })
    ).toEqual({ SANDBOX_ENV_SECRETS_KEY: 'sealing-key-value' });
  });
});

describe('what the page is shown', () => {
  it('is every setting and only WHICH secrets are stored', () => {
    const input = parsed(form());
    const view = orchestratorViewOfRow({
      enabled: true,
      settings: { ...input.settings },
      secrets: {
        'env.DELEGATE_WORKER_API_KEY': 'sealing-key-value',
        [AZURE_CLIENT_SECRET_KEY]: 's3cret',
      },
    });
    expect(view).toMatchObject({
      configured: true,
      enabled: true,
      hasAzureClientSecret: true,
      envStored: ['DELEGATE_WORKER_API_KEY'],
    });
    expect(JSON.stringify(view)).not.toContain('sealing-key-value');
    expect(JSON.stringify(view)).not.toContain('s3cret');
  });

  it('is the defaults, not configured, before anything is saved', () => {
    expect(orchestratorViewOfRow(null)).toEqual({
      configured: false,
      enabled: false,
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      hasAzureClientSecret: false,
      envStored: [],
    });
  });

  it('reads a row written by an older build without tripping on what it does not say', () => {
    expect(
      orchestratorSettingsOfRow({ provider: 'docker', docker: 'nonsense', azure: null })
    ).toEqual({ ...DEFAULT_ORCHESTRATOR_SETTINGS, provider: 'docker' });
  });
});
