/**
 * The Docker provider against a real engine, under the real orchestrator:
 * a sandbox is made, answers, is suspended, resumed and removed. Skipped
 * unless SANDBOX_LIVE_DOCKER_HOST names an engine
 * (`unix:///var/run/docker.sock`); the image is a stand-in that answers
 * `/health` on the worker's port, so the sandbox image need not be built:
 *
 *   docker pull node:24-alpine
 *   SANDBOX_LIVE_DOCKER_HOST=unix:///var/run/docker.sock pnpm test docker-provider.live
 */

import { createMemoryDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { DockerSandboxProvider } from './docker-provider';
import { Orchestrator } from './orchestrator';

const host = process.env.SANDBOX_LIVE_DOCKER_HOST;
const image = process.env.SANDBOX_LIVE_DOCKER_IMAGE ?? 'node:24-alpine';
const live = host ? describe : describe.skip;

/** A worker's worth of `/health`: says it is up, and which key it was started with. */
const STAND_IN = `require('http').createServer((q, s) => {
  s.setHeader('content-type', 'application/json');
  s.end(JSON.stringify({ ok: true, capabilities: { browser: false }, key: process.env.SANDBOX_WORKER_API_KEY }));
}).listen(8092, '0.0.0.0');
process.on('SIGTERM', () => process.exit(0));`;

const MINUTE = 60_000;

live.each(['stop', 'pause'] as const)(
  'a sandbox on a real Docker engine, suspended by %s',
  (suspend) => {
    const deployment = `live-test-${suspend}-${Date.now()}`;
    const provider = new DockerSandboxProvider({
      image,
      networks: [],
      publishHost: '127.0.0.1',
      command: ['node', '-e', STAND_IN],
      memoryBytes: 256 * 1_048_576,
      shmBytes: 64 * 1_048_576,
      pidsLimit: 128,
      cpus: 1,
      suspend,
      deployment,
      host,
    });
    const data = createMemoryDataStore();
    // The idle rules run on this clock; the engine and the worker on the real one.
    let skew = 0;
    const orchestrator = new Orchestrator({
      provider,
      store: () => data.sandboxes,
      masterKey: 'live-master',
      env: { GREETING: 'hello' },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => Date.now() + skew,
      readyTimeoutMs: 60_000,
    });

    afterAll(async () => {
      for (const machine of await provider.list()) await provider.destroy(machine.providerId);
    });

    it('is made, answers with its own key, is suspended when idle, resumed by a call, and removed', async () => {
      await provider.check();

      const first = await orchestrator.ensure('ann');
      const health: unknown = await (await fetch(`${first.url}/health`)).json();
      expect(isRecord(health) && health.key).toBe(first.key);
      expect(await provider.list()).toEqual([
        expect.objectContaining({ sandboxId: first.sandboxId, state: 'running' }),
      ]);

      skew += 16 * MINUTE;
      expect(await orchestrator.sweep()).toMatchObject({ suspended: 1, failures: 0 });
      expect((await provider.list())[0]?.state).toBe('suspended');
      await expect(
        fetch(`${first.url}/health`, { signal: AbortSignal.timeout(1_500) })
      ).rejects.toBeDefined();

      const again = await orchestrator.ensure('ann');
      expect(again.sandboxId).toBe(first.sandboxId);
      expect(again.key).toBe(first.key);
      expect((await fetch(`${again.url}/health`)).ok).toBe(true);

      skew += 25 * 60 * MINUTE;
      expect(await orchestrator.sweep()).toMatchObject({ removed: 1, failures: 0 });
      expect(await provider.list()).toEqual([]);
      expect(await data.sandboxes.live('ann')).toBeNull();
    }, 180_000);
  }
);
