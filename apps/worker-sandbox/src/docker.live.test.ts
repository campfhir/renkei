/**
 * The engine calls code project services make, against a real engine —
 * the Docker engine, or Podman's Docker-compatible API, which is what an
 * orchestrated sandbox runs inside itself (docs/sandbox-orchestrator-design.md).
 * Skipped unless SANDBOX_LIVE_ENGINE_HOST names one:
 *
 *   podman system service --time=0 unix:///tmp/podman.sock &
 *   SANDBOX_LIVE_ENGINE_HOST=unix:///tmp/podman.sock pnpm test docker.live
 *
 * SANDBOX_LIVE_ENGINE_IMAGE is the service started (default
 * docker.io/library/redis:7-alpine); it is pulled through the engine.
 */

import { connect } from 'node:net';
import { DockerClient, parseDockerHost } from './docker';

const host = process.env.SANDBOX_LIVE_ENGINE_HOST;
const image = process.env.SANDBOX_LIVE_ENGINE_IMAGE ?? 'docker.io/library/redis:7-alpine';
const live = host ? describe : describe.skip;

/** Whether something accepts a connection at the address: a service reached by its bridge address. */
function reachable(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port, timeout: 3_000 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

live('a code project service on a real engine', () => {
  const engine = new DockerClient(parseDockerHost(host));
  const network = `renkei-live-${Date.now()}`;
  const name = `renkei-live-service-${Date.now()}`;
  let id = '';

  afterAll(async () => {
    if (id) await engine.removeContainer(id).catch(() => undefined);
  });

  it('is pulled, started on its own network, reached by address, read, stopped and removed', async () => {
    const version = await engine.version();
    expect(version.version).not.toBe('unknown');

    const [repository, tag] = [
      image.slice(0, image.lastIndexOf(':')),
      image.slice(image.lastIndexOf(':') + 1),
    ];
    await engine.pullImage(repository!, tag!, null, 120_000);
    expect(await engine.imagePorts(image)).toEqual([6379]);

    await engine.ensureNetwork(network);
    await engine.ensureNetwork(network);
    id = await engine.createContainer({
      name,
      image,
      env: { GREETING: 'hello' },
      labels: { 'renkei.sandbox.service': '1' },
      network,
      memoryBytes: 256 * 1_048_576,
      pidsLimit: 128,
    });
    await engine.startContainer(id);

    let state = await engine.inspectContainer(id, network);
    for (let attempt = 0; attempt < 20 && !(state?.running && state.ip); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await engine.inspectContainer(id, network);
    }
    expect(state).toMatchObject({ running: true, status: 'running' });
    expect(state?.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // The worker is not a container of this engine inside a sandbox: the
    // service is reached at its bridge address from the machine itself.
    let up = false;
    for (let attempt = 0; attempt < 20 && !up; attempt += 1) {
      up = await reachable(state!.ip!, 6379);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(up).toBe(true);

    expect(await engine.containerLogs(id, 50)).toMatch(/Ready to accept connections/);
    expect(
      (await engine.listContainers('renkei.sandbox.service')).map((entry) => entry.id)
    ).toContain(id);

    await engine.stopContainer(id, 5);
    expect(await engine.inspectContainer(id, network)).toMatchObject({ running: false, ip: null });
    await engine.removeContainer(id);
    expect(await engine.inspectContainer(id, network)).toBeNull();
    id = '';
  }, 180_000);
});
