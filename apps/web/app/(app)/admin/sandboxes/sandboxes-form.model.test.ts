import type { SandboxesView } from '@/lib/sandboxes-admin';
import {
  SUGGESTED_ENV,
  asksEntraAllowed,
  badge,
  canPrepareImage,
  canSubmit,
  clientSecretPlaceholder,
  envPlaceholder,
  imageLine,
  init,
  leavesImageToOrchestrator,
  orchestratorLine,
  prepareImageLabel,
  reducer,
  requestBody,
  saveLabel,
  testLabel,
  usesServicePrincipal,
  canCancelTest,
  canTest,
  cancelTestLabel,
  runningTestId,
  testRunning,
  testSteps,
  type CheckJob,
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
      imageRepository: 'docker.io/scotteremiaroden/renkei-sandbox',
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
  check: null,
};

/** A test job as the orchestrator answers it. */
const job = (
  state: CheckJob['state'],
  steps: string[] = [],
  detail: string | null = null,
  id = 'job-1'
): CheckJob => ({
  id,
  state,
  steps: steps.map((text) => ({ at: '2026-11-17T06:00:00.000Z', text })),
  detail,
  startedAt: '2026-11-17T06:00:00.000Z',
  endedAt: state === 'running' ? null : '2026-11-17T06:03:00.000Z',
});

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
    expect(canTest(state)).toBe(false);
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

  it('a test is started as a job: the button is off and reads "Testing…" until it ends, and it can be cancelled', () => {
    const starting = run(init(STORED), { type: 'sent', what: 'test' });
    expect(testLabel(starting)).toBe('Starting the test…');
    expect(canTest(starting)).toBe(false);
    const running = run(starting, {
      type: 'checkStarted',
      job: job('running', ['Reaching the group.']),
    });
    expect(testRunning(running)).toBe(true);
    expect(canTest(running)).toBe(false);
    expect(testLabel(running)).toBe('Testing…');
    expect(canCancelTest(running)).toBe(true);
    expect(runningTestId(running)).toBe('job-1');
    expect(running.notice).toBeNull();
    expect(running.error).toBeNull();
    // Saving is not held up by a test.
    expect(canSubmit(running)).toBe(true);
  });

  it('shows each step as it is read, and the answer once, when the test ends', () => {
    const running = run(init(STORED), {
      type: 'checkStarted',
      job: job('running', ['Reaching the group.']),
    });
    const further = run(running, {
      type: 'checkRead',
      job: job('running', ['Reaching the group.', 'Making a test sandbox.']),
    });
    expect(testSteps(further)).toEqual(['Reaching the group.', 'Making a test sandbox.']);
    expect(further.notice).toBeNull();
    const passed = run(further, {
      type: 'checkRead',
      job: job('passed', ['Reaching the group.', 'Making a test sandbox.'], 'Its worker answered.'),
    });
    expect(passed.notice).toBe('Its worker answered.');
    expect(canTest(passed)).toBe(true);
    expect(testRunning(passed)).toBe(false);
    // Read again after an edit cleared it, the same ended test is not shown twice.
    const edited = run(
      passed,
      { type: 'setAzure', patch: { region: 'westus2' } },
      {
        type: 'checkRead',
        job: job('passed', [], 'Its worker answered.'),
      }
    );
    expect(edited.notice).toBeNull();
  });

  it('a test that failed, or was cancelled, says why as an error; neither saves', () => {
    const running = run(init(STORED), { type: 'checkStarted', job: job('running') });
    const failed = run(running, {
      type: 'checkRead',
      job: job('failed', [], 'AuthorizationFailed'),
    });
    expect(failed.error).toBe('AuthorizationFailed');
    expect(failed.view).toBe(STORED);
    const cancelling = run(running, { type: 'sent', what: 'cancel' });
    expect(cancelTestLabel(cancelling)).toBe('Cancelling…');
    expect(canCancelTest(cancelling)).toBe(false);
    const cancelled = run(
      cancelling,
      { type: 'checkStarted', job: job('running') },
      { type: 'checkRead', job: job('cancelled', [], 'Cancelled: an operator stopped it.') }
    );
    expect(cancelled.error).toBe('Cancelled: an operator stopped it.');
    expect(canTest(cancelled)).toBe(true);
  });

  it('a test that could not start answers at once, as an error', () => {
    const state = run(
      init(STORED),
      { type: 'sent', what: 'test' },
      {
        type: 'checkStarted',
        job: job('failed', [], 'Enter a value for DELEGATE_WORKER_API_KEY.', 'not-started'),
      }
    );
    expect(state.error).toBe('Enter a value for DELEGATE_WORKER_API_KEY.');
    expect(canTest(state)).toBe(true);
  });

  it('a page opened while a test runs picks it up, steps and all', () => {
    const state = init({ ...STORED, check: job('running', ['Waiting for the disk image.']) });
    expect(testRunning(state)).toBe(true);
    expect(canTest(state)).toBe(false);
    expect(testSteps(state)).toEqual(['Waiting for the disk image.']);
  });

  it('editing anything clears the last result', () => {
    const state = run(
      init(STORED),
      { type: 'checkStarted', job: job('passed', [], 'Reached it.') },
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

describe('the disk image sandboxes boot from', () => {
  const IMAGE = {
    build: '12112db',
    base: 'docker.io/scotteremiaroden/renkei-sandbox:12112db66f6bdd6fd42846039b8b9e9432136eb7',
    diskImageId: 'img-1',
  };
  const automatic = (
    image: Record<string, unknown> | null,
    problem: string | null = null
  ): SandboxesView => ({
    ...STORED,
    settings: { ...STORED.settings, azure: { ...STORED.settings.azure, diskImage: '' } },
    orchestrator: {
      ...WIRED,
      problem,
      image: image === null ? null : { ...IMAGE, detail: null, state: 'ready', ...image },
    },
  });

  it('is left to the orchestrator when none is pinned, and then asks where the sandbox image comes from', () => {
    const state = init(automatic({}));
    expect(leavesImageToOrchestrator(state)).toBe(true);
    expect(state.draft.azure.imageRepository).toBe('docker.io/scotteremiaroden/renkei-sandbox');
    expect(leavesImageToOrchestrator(init(STORED))).toBe(false);
    const pinned = run(init(automatic({})), {
      type: 'setAzure',
      patch: { diskImage: 'img-pinned' },
    });
    expect(leavesImageToOrchestrator(pinned)).toBe(false);
    expect(requestBody(pinned).azure).toMatchObject({ diskImage: 'img-pinned' });
  });

  it('does not show "being prepared" once the image reports ready, in the moment before the orchestrator takes it up', () => {
    const state = init(
      automatic(
        {},
        'the disk image for build 12112db is being prepared from x; sandboxes are made once it is ready'
      )
    );
    expect(orchestratorLine(state)).toEqual({
      tone: 'ok',
      text: 'The disk image for build 12112db is ready; the orchestrator is making sandboxes from it.',
    });
  });

  it('says which build sandboxes boot from once it is ready', () => {
    expect(imageLine(init(automatic({})))).toBe(
      `Sandboxes boot from the disk image built for build 12112db (img-1), from ${IMAGE.base}.`
    );
    // While it is prepared, or when it failed, the orchestrator's own line says so instead.
    expect(imageLine(init(automatic({ state: 'preparing' })))).toBeNull();
    expect(imageLine(init(STORED))).toBeNull();
  });

  it('can be prepared again only after a failed build, one thing at a time', () => {
    const failed = init(
      automatic(
        { state: 'failed', detail: 'manifest unknown' },
        'the disk image for build 12112db could not be prepared — manifest unknown'
      )
    );
    expect(canPrepareImage(failed)).toBe(true);
    expect(orchestratorLine(failed)).toEqual({
      tone: 'warn',
      text: 'No sandbox can be made: the disk image for build 12112db could not be prepared — manifest unknown.',
    });
    expect(canPrepareImage(init(automatic({})))).toBe(false);
    expect(canPrepareImage(init(automatic({ state: 'preparing' })))).toBe(false);

    const asking = run(failed, { type: 'sent', what: 'image' });
    expect(prepareImageLabel(asking)).toBe('Asking…');
    expect(canPrepareImage(asking)).toBe(false);
    expect(canSubmit(asking)).toBe(false);
  });

  it('prepared again shows what the orchestrator says now, and keeps what was being typed', () => {
    const failed = init(
      automatic({ state: 'failed', detail: 'manifest unknown' }, 'could not be prepared')
    );
    const typed = run(
      failed,
      { type: 'setAzure', patch: { cpu: '4000m' } },
      { type: 'sent', what: 'image' }
    );
    const after = run(typed, {
      type: 'imagePrepared',
      view: automatic(
        { state: 'preparing', detail: 'Building' },
        'the disk image for build 12112db is being prepared'
      ),
    });
    expect(after.busy).toBeNull();
    expect(after.draft.azure.cpu).toBe('4000m');
    expect(after.view?.orchestrator.image?.state).toBe('preparing');
    expect(canPrepareImage(after)).toBe(false);
  });
});
