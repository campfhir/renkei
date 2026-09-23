/**
 * Code project services — the I/O half: a container the Docker engine
 * runs beside a project's checkout, from an image the organization's
 * allow-list admits (image-rules-store.ts), reachable from the project's
 * commands by address on a network of its own. The pure half (the
 * reference, the rules, the environment a service announces itself
 * with) is @renkei/connector-sandbox's services.ts; the HTTP surface is
 * service-endpoints.ts.
 *
 * Where the containment lives, since a project's command now has a
 * neighbour:
 *
 *  - The engine answers to THIS process. The socket (or the proxy in
 *    front of it) is root's; a caller's uid cannot open it. What a
 *    project may start is decided here, against the organization's
 *    rules, never by anything a command can run.
 *  - The image is the boundary. A rule allows a registry, a namespace or
 *    a repository — never "anything"; the most specific rule wins and
 *    its host's credential rides the pull, in that one request. The
 *    reference is normalized before it is matched, so `postgres`,
 *    `docker.io/postgres:16` and `index.docker.io/library/postgres` are
 *    one repository to the rules.
 *  - The container is a plain one. No privileges, no-new-privileges,
 *    a memory and a pids ceiling, no restart policy, no published ports,
 *    on an INTERNAL network (no route out of it), so an image that
 *    turned out to be more than a database cannot reach the internet or
 *    the other compose services from there. It is reached by address from
 *    this worker's own container (connected to the same network at
 *    boot), which is where every project's commands run — so, as with
 *    the checkouts' shared network, one project can reach another's
 *    service if it knows the address and the password; the password is
 *    the project's own, never shared.
 *  - Lifetime. A service lives SERVICE_TTL_MS past its last use (any
 *    command in the project); the sweep stops and removes it after,
 *    with its anonymous volumes, and removes any container carrying our
 *    label that no row claims.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  SERVICE_MAX_PER_SUBJECT,
  SERVICE_START_TIMEOUT_MS,
  mergeLogEntries,
  parseStampedLogs,
  type ServiceLogEntry,
  matchImageRule,
  imageRuleHost,
  parseImageReference,
  serviceEnvironment,
  subjectSegmentOf,
  type ImageReference,
} from '@renkei/connector-sandbox';
import { DockerError, type DockerEngine, type RegistryAuth } from './docker';
import * as store from './service-store';
import * as rules from './image-rules-store';
import { logger } from './logger';

export const SERVICE_LABEL = 'renkei.sandbox.service';
const LABEL_TENANT = 'renkei.sandbox.tenant';
const LABEL_SUBJECT = 'renkei.sandbox.subject';
const LABEL_ID = 'renkei.sandbox.id';
const LABEL_NAME = 'renkei.sandbox.name';

const STOP_GRACE_SECONDS = 10;
/** How long a freshly started container gets to be running with an address before it is judged. */
const READY_WAIT_MS = 3_000;
const READY_POLL_MS = 250;
const FAILURE_LOG_LINES = 40;

export interface ServiceManagerOptions {
  db: Kysely<DB>;
  engine: DockerEngine;
  /** The network every service is created on and this worker is attached to. */
  network: string;
  /** This worker's own container, attached to the network at boot; null when not in one. */
  selfContainer: string | null;
  memoryBytes: number;
  pidsLimit: number;
}

export class ServiceOpError extends Error {
  constructor(
    readonly type:
      'not_allowed' | 'not_found' | 'exists' | 'quota_exceeded' | 'engine' | 'bad_request',
    message: string
  ) {
    super(message);
    this.name = 'ServiceOpError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(id: string): string {
  return id.replace(/-/g, '').slice(0, 12);
}

function engineMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServiceManager {
  private readonly db: Kysely<DB>;
  private readonly engine: DockerEngine;
  private readonly network: string;
  private readonly selfContainer: string | null;
  private readonly memoryBytes: number;
  private readonly pidsLimit: number;

  constructor(options: ServiceManagerOptions) {
    this.db = options.db;
    this.engine = options.engine;
    this.network = options.network;
    this.selfContainer = options.selfContainer;
    this.memoryBytes = options.memoryBytes;
    this.pidsLimit = options.pidsLimit;
  }

  /** At boot: the engine answers, the network exists, this worker is on it. Throws with why otherwise. */
  async prepare(): Promise<{ version: string; apiVersion: string }> {
    const version = await this.engine.version();
    await this.engine.ensureNetwork(this.network);
    if (this.selfContainer) await this.engine.connectToNetwork(this.network, this.selfContainer);
    return version;
  }

  /** Which rule admits an image, and the credential its host pulls with — or the refusal. */
  private async admit(
    tenantId: string,
    image: ImageReference
  ): Promise<{ auth: RegistryAuth | null }> {
    const all = await rules.listImageRulesForMatching(this.db, tenantId);
    const winner = matchImageRule(all, image);
    if (!winner) {
      const allowed = all.map((rule) => rule.pattern).sort();
      throw new ServiceOpError(
        'not_allowed',
        `${image.canonical} is not an image this organization allows. ` +
          (allowed.length
            ? `Allowed: ${allowed.join(', ')}. `
            : 'The organization allows no images yet. ') +
          'An operator changes the list under Organization → Code services.'
      );
    }
    // The winning rule's credential, else any rule for the same host that has one.
    const key = rules.registrySecretsKey();
    const candidates = [
      winner,
      ...all.filter((rule) => rule.id !== winner.id && imageRuleHost(rule.pattern) === image.host),
    ];
    for (const candidate of candidates) {
      if (!candidate.registryUsername || !candidate.registrySealed) continue;
      const secret = key ? rules.openRegistrySecret(candidate.registrySealed, key) : null;
      if (secret === null) {
        throw new ServiceOpError(
          'engine',
          `The registry credential for ${image.host} cannot be opened on this worker (its sealing key changed); an operator has to enter it again.`
        );
      }
      return {
        auth: {
          username: candidate.registryUsername,
          password: secret,
          serveraddress: image.host === 'docker.io' ? 'https://index.docker.io/v1/' : image.host,
        },
      };
    }
    return { auth: null };
  }

  async start(
    target: store.ServiceTarget,
    input: {
      name: string;
      image: string;
      env: Record<string, string>;
      exports: Record<string, string>;
    }
  ): Promise<store.StoredService> {
    const parsed = parseImageReference(input.image);
    if (!parsed.ok) throw new ServiceOpError('bad_request', parsed.message);
    const image = parsed.image;

    const existing = await store.getServiceByName(this.db, target, input.name);
    if (existing) {
      const state = await this.reconcile(existing);
      if (state.status === 'running' || state.status === 'starting') {
        throw new ServiceOpError(
          'exists',
          `A service named ${input.name} is already ${state.status} (${state.image}); stop it first, or pick another name.`
        );
      }
      // A stopped, failed or vanished one under that name makes way.
      await this.remove(state);
    }
    const others = await store.listServices(this.db, target);
    const running = others.filter((row) => row.status === 'running' || row.status === 'starting');
    if (running.length >= SERVICE_MAX_PER_SUBJECT) {
      throw new ServiceOpError(
        'quota_exceeded',
        `A project runs at most ${SERVICE_MAX_PER_SUBJECT} services at once; stop one first.`
      );
    }
    const { auth } = await this.admit(target.tenantId, image);

    const row = await store.insertService(this.db, {
      ...target,
      name: input.name,
      image: image.canonical,
      exports: input.exports,
    });
    const fail = async (message: string): Promise<never> => {
      await store.updateService(this.db, row.id, { status: 'failed', error: message });
      throw new ServiceOpError('engine', message);
    };

    try {
      await this.engine.pullImage(
        `${image.host}/${image.path}`,
        image.digest ?? image.tag ?? 'latest',
        auth,
        SERVICE_START_TIMEOUT_MS
      );
    } catch (error) {
      return fail(`The image could not be pulled: ${engineMessage(error)}`);
    }
    let ports: number[] = [];
    try {
      ports = await this.engine.imagePorts(image.canonical);
    } catch (error) {
      logger.warn('could not read the ports of {image}: {error}', {
        component: 'worker-sandbox/services',
        image: image.canonical,
        error: engineMessage(error),
      });
    }
    let containerId: string;
    try {
      containerId = await this.engine.createContainer({
        name: `renkei-svc-${short(row.id)}`,
        image: image.canonical,
        env: input.env,
        labels: {
          [SERVICE_LABEL]: '1',
          [LABEL_TENANT]: target.tenantId,
          [LABEL_SUBJECT]: subjectSegmentOf(target.subject),
          [LABEL_ID]: row.id,
          [LABEL_NAME]: input.name,
        },
        network: this.network,
        memoryBytes: this.memoryBytes,
        pidsLimit: this.pidsLimit,
      });
    } catch (error) {
      return fail(`The container could not be created: ${engineMessage(error)}`);
    }
    await store.updateService(this.db, row.id, { containerId, ports });
    try {
      await this.engine.startContainer(containerId);
    } catch (error) {
      await this.engine.removeContainer(containerId).catch(() => undefined);
      return fail(`The container could not be started: ${engineMessage(error)}`);
    }

    // Running with an address, or gone straight back down: a database
    // handed a bad environment exits within a second, and its last
    // lines say why better than "not running" ever would.
    const deadline = Date.now() + READY_WAIT_MS;
    let state = await this.engine.inspectContainer(containerId, this.network);
    while (state && state.running && !state.ip && Date.now() < deadline) {
      await sleep(READY_POLL_MS);
      state = await this.engine.inspectContainer(containerId, this.network);
    }
    if (!state || !state.running) {
      const tail = state
        ? await this.engine.containerLogs(containerId, FAILURE_LOG_LINES).catch(() => '')
        : '';
      await this.engine.removeContainer(containerId).catch(() => undefined);
      await store.updateService(this.db, row.id, { containerId: null });
      return fail(
        `The container exited right after starting${state?.exitCode !== null && state?.exitCode !== undefined ? ` (exit ${state.exitCode})` : ''}.` +
          (tail.trim() ? `\n--- last log lines ---\n${tail.trim()}` : '')
      );
    }
    await store.updateService(this.db, row.id, {
      status: 'running',
      error: null,
      host: state.ip,
      ports,
    });
    logger.info('started service {name} ({image}) for {subject} as {container}', {
      component: 'worker-sandbox/services',
      name: input.name,
      image: image.canonical,
      subject: target.subject,
      container: containerId,
    });
    return (
      (await store.getServiceByName(this.db, target, input.name)) ?? {
        ...row,
        status: 'running',
        host: state.ip,
        ports,
        containerId,
      }
    );
  }

  /**
   * A row against the engine: a container that is gone marks the row
   * `gone`, one that stopped on its own `stopped` (with its exit code),
   * and a running one keeps its address fresh.
   */
  private async reconcile(service: store.StoredService): Promise<store.StoredService> {
    if (!service.containerId) return service;
    if (service.status === 'failed' || service.status === 'gone') return service;
    let state;
    try {
      state = await this.engine.inspectContainer(service.containerId, this.network);
    } catch (error) {
      logger.warn('could not inspect {container}: {error}', {
        component: 'worker-sandbox/services',
        container: service.containerId,
        error: engineMessage(error),
      });
      return service;
    }
    if (!state) {
      await store.updateService(this.db, service.id, {
        status: 'gone',
        host: null,
        error: 'The container is no longer on the engine.',
      });
      return {
        ...service,
        status: 'gone',
        host: null,
        error: 'The container is no longer on the engine.',
      };
    }
    if (!state.running) {
      if (service.status !== 'stopped') {
        const error = `The container is ${state.status}${state.exitCode !== null ? ` (exit ${state.exitCode})` : ''}.`;
        await store.updateService(this.db, service.id, { status: 'stopped', host: null, error });
        return { ...service, status: 'stopped', host: null, error };
      }
      return service;
    }
    if (service.status !== 'running' || service.host !== state.ip) {
      await store.updateService(this.db, service.id, {
        status: 'running',
        host: state.ip,
        error: null,
      });
      return { ...service, status: 'running', host: state.ip, error: null };
    }
    return service;
  }

  async list(target: store.ServiceTarget): Promise<store.StoredService[]> {
    const rows = await store.listServices(this.db, target);
    const out: store.StoredService[] = [];
    for (const row of rows) out.push(await this.reconcile(row));
    return out;
  }

  async get(target: store.ServiceTarget, name: string): Promise<store.StoredService> {
    const row = await store.getServiceByName(this.db, target, name);
    if (!row) throw new ServiceOpError('not_found', `No service named ${name} — see the list.`);
    return this.reconcile(row);
  }

  async logs(
    target: store.ServiceTarget,
    name: string,
    lines: number
  ): Promise<{ service: store.StoredService; logs: string }> {
    const service = await this.get(target, name);
    if (!service.containerId || service.status === 'gone') {
      return { service, logs: '' };
    }
    try {
      return { service, logs: await this.engine.containerLogs(service.containerId, lines) };
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return { service, logs: '' };
      throw new ServiceOpError('engine', `The logs could not be read: ${engineMessage(error)}`);
    }
  }

  /**
   * Every service's recent lines in one time-ordered stream, for the
   * project's Services page: `lines` from each container (the running
   * and the stopped alike, while the container is there), stamped by
   * the engine so they interleave, and only those after `since` when
   * the page is following. A service whose logs cannot be read is
   * named rather than failing the rest.
   */
  async tail(
    target: store.ServiceTarget,
    input: { lines: number; since: string | null }
  ): Promise<{ entries: ServiceLogEntry[]; truncated: boolean; unreadable: string[] }> {
    const rows = await store.listServices(this.db, target);
    const perService: ServiceLogEntry[][] = [];
    const unreadable: string[] = [];
    for (const row of rows) {
      const service = await this.reconcile(row);
      if (!service.containerId || service.status === 'gone') continue;
      try {
        const text = await this.engine.containerLogs(service.containerId, input.lines, {
          timestamps: true,
          ...(input.since ? { since: input.since } : {}),
        });
        perService.push(parseStampedLogs(service.name, text));
      } catch (error) {
        if (!(error instanceof DockerError && error.status === 404)) unreadable.push(service.name);
      }
    }
    return { ...mergeLogEntries(perService), unreadable };
  }

  /** Stop the container, remove it with its volumes, forget the row. */
  private async remove(service: store.StoredService): Promise<void> {
    if (service.containerId) {
      try {
        await this.engine.stopContainer(service.containerId, STOP_GRACE_SECONDS);
        await this.engine.removeContainer(service.containerId);
      } catch (error) {
        throw new ServiceOpError(
          'engine',
          `The container could not be removed: ${engineMessage(error)}`
        );
      }
    }
    await store.deleteServiceById(this.db, service.id);
  }

  async stop(target: store.ServiceTarget, name: string): Promise<store.StoredService> {
    const service = await this.get(target, name);
    await this.remove(service);
    logger.info('stopped service {name} for {subject}', {
      component: 'worker-sandbox/services',
      name,
      subject: target.subject,
    });
    return { ...service, status: 'stopped', host: null };
  }

  /**
   * What a command in the project runs with, from its running services:
   * `SERVICE_<NAME>_HOST` and friends and each service's exports. A use
   * extends every running service's lifetime.
   */
  async environmentFor(target: store.ServiceTarget): Promise<Record<string, string>> {
    const rows = await store.listServices(this.db, target);
    if (rows.length === 0) return {};
    const running: Array<{
      name: string;
      host: string;
      ports: number[];
      exports: Record<string, string>;
    }> = [];
    const used: string[] = [];
    for (const row of rows) {
      const current = await this.reconcile(row);
      if (current.status !== 'running' || !current.host) continue;
      running.push({
        name: current.name,
        host: current.host,
        ports: current.ports,
        exports: current.exports,
      });
      used.push(current.id);
    }
    await store.touchServices(this.db, used);
    return serviceEnvironment(running);
  }

  /**
   * Expired services lose their container, then their row; a container
   * carrying our label that no row claims (a row deleted with its
   * tenant, a crash between create and the row's update) goes too. One
   * failure never stops the batch.
   */
  async sweep(limit: number): Promise<void> {
    const expired = await store.listExpiredServices(this.db, limit);
    for (const service of expired) {
      try {
        await this.remove(service);
        logger.info('swept expired service {name} ({id})', {
          component: 'worker-sandbox/services',
          name: service.name,
          id: service.id,
        });
      } catch (error) {
        logger.warn('sweep could not remove service {id}: {error}', {
          component: 'worker-sandbox/services',
          id: service.id,
          error: engineMessage(error),
        });
      }
    }
    try {
      const labelled = await this.engine.listContainers(`${SERVICE_LABEL}=1`);
      if (labelled.length === 0) return;
      const claimed = await store.listClaimedContainerIds(this.db);
      for (const container of labelled) {
        if (claimed.has(container.id)) continue;
        await this.engine.removeContainer(container.id);
        logger.info('removed orphaned service container {container}', {
          component: 'worker-sandbox/services',
          container: container.id,
        });
      }
    } catch (error) {
      logger.warn('sweep could not check for orphaned service containers: {error}', {
        component: 'worker-sandbox/services',
        error: engineMessage(error),
      });
    }
  }
}
