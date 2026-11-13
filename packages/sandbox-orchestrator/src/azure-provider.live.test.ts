/**
 * The Azure provider against a REAL sandbox group: one smallest-size
 * sandbox is made from Microsoft's public `ubuntu` image, seen running,
 * suspended, resumed and removed — removed whatever happens, in
 * `afterAll`. Skipped unless SANDBOX_LIVE_AZURE_SUBSCRIPTION_ID is set.
 *
 *   SANDBOX_LIVE_AZURE_SUBSCRIPTION_ID, _RESOURCE_GROUP, _SANDBOX_GROUP, _REGION
 *   SANDBOX_LIVE_AZURE_TOKEN   optional: a data-plane token
 *       (az account get-access-token --resource https://dynamicsessions.io
 *        --query accessToken -o tsv); without it, DefaultAzureCredential.
 *   SANDBOX_LIVE_AZURE_IMAGE   optional, default the public `ubuntu`.
 *
 * It costs what one XS sandbox costs for the minute it lives. What the
 * platform answered at each step is printed, since this is also how the
 * provider's assumptions about a preview service are checked.
 */

import {
  AzureSandboxProvider,
  createAzureSandboxClient,
  type AzureSandboxClient,
} from './azure-provider';

const env = process.env;
const live = env.SANDBOX_LIVE_AZURE_SUBSCRIPTION_ID ? describe : describe.skip;

function say(step: string, detail: unknown): void {
  // The record of the run: what a preview service really answered.
  console.log(
    `[azure live] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  );
}

async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 180_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

live('a sandbox in a real Azure sandbox group', () => {
  const deployment = `live-test-${Date.now()}`;
  const sandboxId = `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0').slice(-12)}`;
  let client: AzureSandboxClient;
  let provider: AzureSandboxProvider;
  let providerId: string | null = null;

  beforeAll(async () => {
    client = await createAzureSandboxClient({
      subscriptionId: env.SANDBOX_LIVE_AZURE_SUBSCRIPTION_ID ?? '',
      resourceGroup: env.SANDBOX_LIVE_AZURE_RESOURCE_GROUP ?? '',
      sandboxGroup: env.SANDBOX_LIVE_AZURE_SANDBOX_GROUP ?? '',
      region: env.SANDBOX_LIVE_AZURE_REGION ?? '',
      ...(env.SANDBOX_LIVE_AZURE_TOKEN ? { staticToken: env.SANDBOX_LIVE_AZURE_TOKEN } : {}),
    });
    provider = new AzureSandboxProvider({
      diskImage: env.SANDBOX_LIVE_AZURE_IMAGE ?? 'ubuntu',
      diskImagePublic: !env.SANDBOX_LIVE_AZURE_IMAGE,
      // The smallest tier: 0.25 cores, 0.5 GiB, 5 GiB.
      cpu: '250m',
      memory: '512Mi',
      disk: '5Gi',
      suspendMode: 'Disk',
      // Entra on the port is a separate question; this run is the lifecycle.
      portAuth: 'anonymous',
      deployment,
      client,
    });
  });

  afterAll(async () => {
    // Whatever happened above, nothing this run made is left behind.
    const left = await provider.list().catch(() => []);
    for (const machine of left) {
      say('cleanup', `removing ${machine.providerId}`);
      await provider.destroy(machine.providerId).catch((error: unknown) => {
        say('cleanup FAILED — remove by hand', `${machine.providerId}: ${String(error)}`);
      });
    }
    if (providerId) await provider.destroy(providerId).catch(() => undefined);
  }, 180_000);

  it('is reached, made, seen running, suspended, resumed, listed and removed', async () => {
    await provider.check();
    say('check', 'the sandbox group answered');

    ({ providerId } = await provider.create({
      sandboxId,
      kind: 'system',
      env: { RENKEI_LIVE_TEST: '1' },
      idleSuspendSeconds: 300,
    }));
    say('created', providerId);
    say('raw after create', await client.get(providerId));

    const running = await until(
      'the sandbox to be running',
      () => provider.inspect(providerId ?? ''),
      (seen) => seen?.state === 'running'
    );
    say('running', running);
    expect(running).toMatchObject({ providerId, state: 'running', sandboxId });
    // Its worker port has an address the moment it runs.
    expect(running?.address).toMatch(/^https:\/\//);

    expect((await provider.list()).map((machine) => machine.providerId)).toContain(providerId);

    await provider.suspend(providerId);
    say('raw after suspend', await client.get(providerId));
    const suspended = await until(
      'the sandbox to be suspended',
      () => provider.inspect(providerId ?? ''),
      (seen) => seen?.state === 'suspended'
    );
    expect(suspended).toMatchObject({ state: 'suspended', address: null });

    await provider.resume(providerId);
    const resumed = await until(
      'the sandbox to be running again',
      () => provider.inspect(providerId ?? ''),
      (seen) => seen?.state === 'running'
    );
    say('resumed', resumed);
    expect(resumed?.state).toBe('running');

    await provider.destroy(providerId);
    const gone = await until(
      'the sandbox to be gone',
      () => provider.inspect(providerId ?? ''),
      (seen) => seen === null,
      120_000
    );
    say('removed', 'the sandbox is gone');
    expect(gone).toBeNull();
    expect((await provider.list()).map((machine) => machine.providerId)).not.toContain(providerId);
    providerId = null;
  }, 600_000);
});
