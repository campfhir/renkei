import { openSandboxEnv } from '@renkei/connector-sandbox';
import { FakeSandboxProvider } from './fake-provider';
import { TrialSandboxes, trySandbox, type TrialProbe } from './trial';

const MASTER = 'master-key';
const CALLBACK = 'https://renkei.example.org/';
const SECRETS = { SANDBOX_ENV_SECRETS_KEY: 'sealing-key' };

/** A clock that moves only when the test sandbox's loop sleeps. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/**
 * The worker inside the fake sandbox, as the real one boots: it asks for
 * its environment with the key and id it was created with, opens it, and
 * only then answers /health. `answer` is what /health says once booted.
 */
function worker(
  provider: FakeSandboxProvider,
  trials: TrialSandboxes,
  options: { boots?: boolean; answer?: number } = {}
) {
  const opened: Array<Record<string, string> | null> = [];
  const probe: TrialProbe = async (address) => {
    const machine = [...provider.machines.values()].find(
      (m) => provider.addressOf(m.providerId) === address
    );
    if (!machine || options.boots === false) return { status: 0 };
    const id = machine.env.SANDBOX_INSTANCE_ID ?? '';
    const key = machine.env.SANDBOX_WORKER_API_KEY ?? '';
    if (!trials.authenticate(id, key)) return { status: 0 };
    const sealed = trials.sealedEnvironment(id);
    opened.push(sealed ? openSandboxEnv(key, id, sealed) : null);
    return { status: options.answer ?? 200 };
  };
  return { probe, opened };
}

function setup(boot: { boots?: boolean; answer?: number } = {}) {
  const provider = new FakeSandboxProvider();
  const trials = new TrialSandboxes(MASTER);
  const { probe, opened } = worker(provider, trials, boot);
  let n = 0;
  const run = () =>
    trySandbox({
      provider,
      trials,
      masterKey: MASTER,
      callbackUrl: CALLBACK,
      env: SECRETS,
      source: 'the disk image "img-1"',
      newId: () => `trial-${(n += 1)}`,
      timeoutMs: 60_000,
      probe,
      ...clock(),
    });
  return { provider, trials, opened, run };
}

describe('Test connection’s test sandbox', () => {
  it('passes when a sandbox made from the setup fetches its sealed environment and its worker answers, then removes it', async () => {
    const { provider, trials, opened, run } = setup();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('the disk image "img-1"');
    expect(result.detail).toContain('https://renkei.example.org');
    expect(provider.calls).toEqual(['create:trial-1', 'destroy:m1']);
    expect(provider.machines.size).toBe(0);
    // What it was handed opened for it alone, and was the setup's secrets.
    expect(opened).toEqual([SECRETS]);
    // Once the test is over its key opens nothing.
    expect(trials.authenticate('trial-1', 'anything')).toBeNull();
  });

  it('creates the sandbox the way a real one is: its key, its id and the orchestrator’s address, no secrets', async () => {
    const { provider, run } = setup();
    let env: Record<string, string> = {};
    const create = provider.create.bind(provider);
    provider.create = async (spec) => {
      env = spec.env;
      return create(spec);
    };
    await run();
    expect(Object.keys(env).sort()).toEqual([
      'SANDBOX_INSTANCE_ID',
      'SANDBOX_ORCHESTRATED',
      'SANDBOX_ORCHESTRATOR_CALLBACK_URL',
      'SANDBOX_WORKER_API_KEY',
      'SANDBOX_WORKER_PORT',
    ]);
    expect(env.SANDBOX_ORCHESTRATOR_CALLBACK_URL).toBe('https://renkei.example.org');
    expect(Object.values(env)).not.toContain('sealing-key');
  });

  it('says the sandbox never called back, and where, when its worker never asks for its environment', async () => {
    const { provider, run } = setup({ boots: false });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(
      'never asked for its environment at https://renkei.example.org/sandbox/v1/bootstrap'
    );
    expect(provider.machines.size).toBe(0);
  });

  it('says the worker port refused the orchestrator when the sandbox booted but /health is refused', async () => {
    const { provider, run } = setup({ answer: 401 });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('refused the orchestrator (HTTP 401)');
    expect(provider.machines.size).toBe(0);
  });

  it('says what the provider said when no sandbox could be made, and has nothing to remove', async () => {
    const { provider, run } = setup();
    provider.failNext.create = "'sourcesRef.diskImage.isPublic' must be true";
    const result = await run();
    expect(result).toEqual({
      ok: false,
      detail:
        'Could not make a test sandbox from the disk image "img-1": \'sourcesRef.diskImage.isPublic\' must be true',
    });
    expect(provider.calls).toEqual(['create:trial-1']);
  });

  it('says so when the test sandbox could not be removed', async () => {
    const { provider, run } = setup();
    provider.failNext.destroy = 'engine busy';
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Removing the test sandbox (m1) failed: engine busy');
  });
});
