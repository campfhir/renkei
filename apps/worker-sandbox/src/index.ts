/**
 * The Renkei sandbox worker — the process that owns the agent scratch
 * space's disk (see docs/sandbox-connector-design.md).
 *
 * File staging is the first place Renkei deliberately holds bytes at rest
 * outside a provider or a browser, so it runs HERE, isolated, instead of
 * inside web request handlers or the shared queue workers — the same
 * reasoning that put SMB/SFTP in apps/worker-fileshares and OnBase egress
 * in apps/worker-onbase. The web app and its MCP tools call this process
 * over bearer-authenticated HTTP (SANDBOX_WORKER_URL on the web side).
 *
 * Env contract:
 *   SANDBOX_WORKER_API_KEY — required; comma-separated bearer keys the web
 *     app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   SANDBOX_WORKER_PORT    — listen port, default 8092.
 *   SANDBOX_DATA_DIR       — where staged files live on disk, default /data.
 *   DATABASE_URL           — the shared Postgres, for file metadata.
 *
 * Which OPTIONAL capabilities this worker offers is not an environment
 * flag (there used to be a SANDBOX_*_ENABLED per capability, read by this
 * process and the web app alike). Two things decide it now, each its own
 * kind of fact:
 *   - what this container has the MEANS for — a Chromium for the browser
 *     and charts (always, baked into the image), a Mermaid bundle for
 *     charts, a Python for scripts, a Docker engine for services — is
 *     found out at boot, below, and a capability with the means is built;
 *     one without answers its verbs 503, with the reason in the boot log;
 *   - whether an ORG may use one is that org's switch (Organization →
 *     Settings → Sandbox, in tenant_settings), read by the web app, which
 *     registers the tools and the Code section only where it is on and
 *     never calls here for a capability the org has not switched on.
 * So this process always runs as root (docker/sandbox-entrypoint.sh):
 * workspaces and scripts are always served, and each caller's commands
 * are dropped to that caller's own uid — without root it still works,
 * unisolated, and says so below.
 *
 *   SANDBOX_BROWSER_EXECUTABLE — optional Chromium binary; by default
 *     playwright-core resolves its own installed headless shell.
 *   SANDBOX_MERMAID_BUNDLE — optional path to Mermaid's browser bundle;
 *     by default the one this package depends on. Without one, charts
 *     are unavailable.
 *   SANDBOX_WORKSPACES_DIR — where checkouts live, default /workspaces
 *     (its own volume, apart from the staged-file disk).
 *   SANDBOX_ENV_SECRETS_KEY — seals workspace environment secrets; falls
 *     back to TOKEN_ENCRYPTION_KEY, and without either the env verbs are
 *     closed.
 *   SANDBOX_DOCKER_HOST — where the Docker engine for code project
 *     services (containers beside a checkout from the images the
 *     organization allows, services.ts) is: `unix:///var/run/docker.sock`
 *     (the default; compose mounts it) or `tcp://host:port` for a socket
 *     proxy in front of it. An engine that does not answer at boot
 *     leaves services unavailable.
 *   SANDBOX_SERVICES_NETWORK — the internal Docker network services are
 *     created on and this worker joins, default `renkei-sandbox-services`.
 *   SANDBOX_CONTAINER_ID — this worker's own container, for joining that
 *     network; defaults to the hostname, which Docker sets to the
 *     container id. Unset and not a container (a developer's checkout),
 *     services are reached at their bridge address directly.
 *   SANDBOX_SERVICE_MEMORY — each service container's memory ceiling,
 *     default 1g; SANDBOX_SERVICE_PIDS its process ceiling, default 512.
 *   SANDBOX_RUNS_DIR — where a script run's throwaway directory is made
 *     (a caller's Python over their own staged files, scripts.ts, behind
 *     sandbox_run_python — run as their own uid and, where the kernel
 *     allows this container to unshare, with no network at all), default
 *     /runs (no volume: nothing here outlives its run).
 *   SANDBOX_PYTHON — the interpreter; by default the image's own
 *     environment with the data libraries (/opt/sandbox-python), else
 *     the `python3` on the PATH. Without one, scripts are unavailable.
 *   SANDBOX_SCRIPT_MEMORY — a run's address-space ceiling, default 2g.
 */

import { closeDatabase, getDatabase } from '@renkei/db';
import { ensureDataRoot, getDataRoot } from './disk';
import { createBrowserStateStore } from './browser-state';
import { createSecretKeyStore } from './secret-key-store';
import {
  canIsolateByUid,
  ensureWorkspacesRoot,
  verifyNetworkIsolation,
  verifyUidIsolation,
} from './workspaces';
import { envSecretsEnabled } from './env-secrets';
import { ScriptRunner, probePython, resolvePython, scriptMemoryBytes } from './scripts';
import { probeLanguageServers } from './lsp-sessions';
import { createSandboxServer, orgMaxFileBytes } from './server';
import { DockerClient, parseDockerHost, parseMemoryBytes } from './docker';
import { ServiceManager } from './services';
import { BrowserSessions } from './browser';
import { ChartRenderer } from './charts';
import { SecretVault } from './secret-vault';
import { createSecretResolver } from './secrets';
import { logger, attachPersistentLogging } from './logger';
import { watchLogLevel } from '@renkei/settings';

/**
 * The most a shutdown may take end to end. Inside the 30s stop grace
 * docker-compose.yaml gives this container, with room for the drain's
 * own wait and the browser's close.
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

function fatal(message: string): never {
  console.error(`FATAL [worker-sandbox]: ${message}`);
  process.exit(1);
}

/**
 * This worker's own container, as the engine knows it — the one to put
 * on the services network so every project's commands (which run in it)
 * can reach a service by address. SANDBOX_CONTAINER_ID when set (compose
 * can name the container); else the hostname, which Docker sets to the
 * container id unless told otherwise, checked against the engine. Null
 * when neither is a container the engine knows: a developer running the
 * worker on the host, where a bridge address is reachable directly.
 */
async function ownContainer(engine: DockerClient): Promise<string | null> {
  const candidates = [process.env.SANDBOX_CONTAINER_ID, process.env.HOSTNAME]
    .map((value) => (value ?? '').trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const found = await engine.inspectContainer(candidate, '');
      if (found) return found.id;
    } catch {
      // The engine is checked properly by prepare(); here a miss is a miss.
    }
  }
  return null;
}

async function main(): Promise<void> {
  await attachPersistentLogging();
  // CONSOLE_LOG_LEVEL/LOG_DB_LEVEL only set the level for the few seconds
  // before the database is reachable; once it is, the org `logLevel` dial
  // (packages/settings) governs, polled and reapplied here so a saved
  // change takes effect without restarting this process.
  watchLogLevel(logger);

  // A rejection nobody awaited must not take the whole worker — and every
  // browser session and unlocked secret — down with it; log it and carry
  // on. A genuinely uncaught exception still exits (the process may be in
  // no state to continue), but says so first, so a restart is explained.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection: {error}', {
      component: 'worker-sandbox/process',
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception, exiting: {error}', {
      component: 'worker-sandbox/process',
      error: error.stack ?? error.message,
    });
    void logger.flush().finally(() => process.exit(1));
  });

  const apiKeys = (process.env.SANDBOX_WORKER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    fatal('SANDBOX_WORKER_API_KEY is required (comma-separated bearer keys)');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) fatal(`database unavailable: ${String(dbResult.err)}`);

  await ensureDataRoot();

  // Workspaces and scripts are always served (whether an org may use
  // them is its own switch, read by the web app — see the header), and
  // both drop a caller's commands to that caller's own uid. So nothing
  // this process creates from here on is readable by those uids: a
  // staged file, a log, a lock.
  process.umask(0o077);
  if (!canIsolateByUid()) {
    logger.warn(
      'this process is not root: workspace commands and scripts run as the worker user with NO per-caller isolation — fine for one developer, wrong for a shared deployment',
      { component: 'worker-sandbox/workspaces' }
    );
  } else {
    // Root only so that each caller's commands can be dropped to their
    // own uid; if that drop cannot happen, the alternative is running
    // every caller's commands as root, which is not an option — so this
    // is fatal here, with the cause, rather than a failed spawn on
    // every command later.
    const problem = await verifyUidIsolation();
    if (problem) {
      fatal(
        `this process is root, but a command cannot be dropped to a caller's uid: ${problem}. ` +
          'The sandbox image (docker/Dockerfile, target sandbox) supplies setpriv from util-linux, and the container needs CAP_SETUID, CAP_SETGID and CAP_SETPCAP (Docker grants them by default).'
      );
    }
  }
  await ensureWorkspacesRoot();
  if (!envSecretsEnabled()) {
    logger.warn(
      'no SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY: workspace environment secrets are closed',
      { component: 'worker-sandbox/workspaces' }
    );
  }
  // Which language servers the code pane can have here: the image
  // installs them (docker/Dockerfile, target sandbox); a developer's
  // machine has whichever are on the PATH. Said once, so an operator
  // can see what a "no server for this language" in the pane means.
  const servers = await probeLanguageServers();
  logger.info('language servers for the code pane: {servers}', {
    component: 'worker-sandbox/lsp',
    servers: servers.length ? servers.join(', ') : 'none',
  });

  // Code project services: containers beside a checkout, from the
  // organization's allowed images — offered when the Docker engine
  // answers now, and otherwise left unavailable with the reason logged
  // once here rather than as a failed start on the first service anyone
  // asks for. A deployment that has no engine to mount simply has no
  // services; an org that switches them on anyway gets the 503.
  let services: ServiceManager | null = null;
  const servicesUnavailable = (reason: string) =>
    logger.info(
      'code project services unavailable: {reason}. Mount the engine socket into this container (docker-compose.yaml, worker-sandbox) or point SANDBOX_DOCKER_HOST at a socket proxy to offer them.',
      { component: 'worker-sandbox/services', reason }
    );
  try {
    const engine = new DockerClient(parseDockerHost(process.env.SANDBOX_DOCKER_HOST));
    const memoryBytes = parseMemoryBytes(process.env.SANDBOX_SERVICE_MEMORY, 1_073_741_824);
    const pidsLimit = Number(process.env.SANDBOX_SERVICE_PIDS ?? '512');
    if (!Number.isInteger(pidsLimit) || pidsLimit <= 0) {
      fatal(`SANDBOX_SERVICE_PIDS is not a usable count: ${process.env.SANDBOX_SERVICE_PIDS}`);
    }
    const selfContainer = await ownContainer(engine);
    const manager = new ServiceManager({
      db: dbResult.val,
      engine,
      network: (process.env.SANDBOX_SERVICES_NETWORK ?? '').trim() || 'renkei-sandbox-services',
      selfContainer,
      memoryBytes,
      pidsLimit,
    });
    const version = await manager.prepare();
    logger.info(
      'services available: Docker engine {version} (API {apiVersion}), this worker {placement}',
      {
        component: 'worker-sandbox/services',
        version: version.version,
        apiVersion: version.apiVersion,
        placement: selfContainer
          ? `is container ${selfContainer}`
          : 'is not a container (services reached by bridge address)',
      }
    );
    services = manager;
  } catch (error) {
    servicesUnavailable(error instanceof Error ? error.message : String(error));
  }

  // Scripts over staged files: a caller's Python, run as their uid in a
  // throwaway directory with — where this container may unshare — no
  // network. The interpreter and its libraries are checked now, so a
  // missing one reads as "unavailable" in the boot log rather than a
  // traceback on the first script anyone runs.
  let scripts: ScriptRunner | null = null;
  const python = await resolvePython(process.env.SANDBOX_PYTHON);
  const probed = python ? await probePython(python) : null;
  if (!python) {
    logger.info(
      'scripts unavailable: no Python interpreter was found. The sandbox image (docker/Dockerfile, target sandbox) installs one at /opt/sandbox-python; point SANDBOX_PYTHON at one to offer them.',
      { component: 'worker-sandbox/scripts' }
    );
  } else if (!probed) {
    logger.warn(
      'scripts unavailable: {python} does not run; point SANDBOX_PYTHON at a working interpreter.',
      { component: 'worker-sandbox/scripts', python }
    );
  } else {
    let memoryBytes: number;
    try {
      memoryBytes = scriptMemoryBytes(process.env.SANDBOX_SCRIPT_MEMORY);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
    const networkProblem = await verifyNetworkIsolation();
    if (networkProblem) {
      logger.warn(
        'scripts are enabled but a run cannot be started without a network ({problem}): scripts run on this container’s network, and every result says so — give the container CAP_SYS_ADMIN (docker-compose.yaml, worker-sandbox) to close that',
        { component: 'worker-sandbox/scripts', problem: networkProblem }
      );
    }
    const runner = new ScriptRunner({
      db: dbResult.val,
      runsRoot: (process.env.SANDBOX_RUNS_DIR ?? '').trim() || '/runs',
      python,
      isolateNetwork: networkProblem === null,
      memoryBytes,
      maxFileBytes: orgMaxFileBytes,
    });
    const removed = await runner.prepare();
    logger.info(
      'scripts available: {python} {version} with {libraries}; network {network}; memory {memory} bytes per run{removed}',
      {
        component: 'worker-sandbox/scripts',
        python,
        version: probed.version,
        libraries: probed.libraries.length ? probed.libraries.join(', ') : 'no data libraries',
        network: networkProblem === null ? 'none per run' : 'the container’s (UNISOLATED)',
        memory: memoryBytes,
        removed: removed
          ? `; ${removed} stale run director${removed === 1 ? 'y' : 'ies'} removed`
          : '',
      }
    );
    scripts = runner;
  }

  const port = Number(process.env.SANDBOX_WORKER_PORT ?? '8092');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`SANDBOX_WORKER_PORT is not a usable port: ${process.env.SANDBOX_WORKER_PORT}`);
  }

  // The browser launches lazily on the first navigate, so enabling it costs
  // nothing until an agent actually opens a page. The secret vault holds
  // a browser secret's key between an unlock and its expiry — on the
  // shared data disk, sealed, so every replica can type it and a restart
  // does not lock it; in this process's memory when there is no key to
  // seal with.
  const secretKeys = createSecretKeyStore(getDataRoot());
  if (!secretKeys) {
    logger.warn(
      'unlocked browser secrets live in this process only (no SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY to seal them on disk): another replica, or this one after a restart, sees them locked',
      { component: 'worker-sandbox/secrets' }
    );
  }
  const vault = new SecretVault({ store: secretKeys });
  // Sessions are kept on the data disk between calls so a replica that
  // did not open one can carry it on; sealed, so only with a key.
  const state = createBrowserStateStore(getDataRoot());
  if (!state) {
    logger.warn(
      'browser sessions live in this process only (no SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY to seal them on disk): a call that lands on another replica, or after a restart, starts over',
      { component: 'worker-sandbox/browser' }
    );
  }
  const browser = new BrowserSessions({
    secrets: createSecretResolver(dbResult.val, vault),
    state,
  });

  // Charts render in a Chromium of their own, launched on the first chart
  // and closed when idle — with no network at all, unlike the browser.
  // Offered when the Mermaid bundle is at hand; without it the chart
  // verbs answer 503 and the boot log says why.
  let charts: ChartRenderer | null = new ChartRenderer();
  if (!charts.mermaidBundle) {
    logger.warn(
      'charts unavailable: the Mermaid bundle was not found. Install this package’s dependencies (mermaid) or point SANDBOX_MERMAID_BUNDLE at mermaid.min.js to offer them.',
      { component: 'worker-sandbox/charts' }
    );
    charts = null;
  }

  const server = createSandboxServer({
    db: dbResult.val,
    apiKeys,
    browser,
    vault,
    charts,
    workspaces: true,
    services,
    scripts,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info(
      'started {application} {version} on port {port} (browser available, charts {charts}, workspaces {workspaces}, services {services}, scripts {scripts}) — which an org may use is its own Settings → Sandbox',
      {
        component: 'worker-sandbox/server',
        port,
        charts: charts ? 'available' : 'unavailable',
        workspaces: canIsolateByUid() ? 'available, per-caller uids' : 'available, UNISOLATED',
        services: services ? 'available' : 'unavailable',
        scripts: scripts
          ? canIsolateByUid()
            ? 'available, per-caller uids'
            : 'available, UNISOLATED'
          : 'unavailable',
      }
    );
  });

  // Stopping, in order: turn new requests away and kill the commands in
  // flight so each caller gets an `interrupted` answer rather than a
  // dropped socket (server.drain, workspaces.interruptRunningProcesses —
  // a `code_run` whose sandbox restarted then reads as exactly that in
  // the chat, and the model runs it again); wait for those answers to go
  // out; then the browser, the charts, the vault, the logs, the database.
  // A second signal changes nothing, and if the whole of it has not
  // finished inside SHUTDOWN_DEADLINE_MS the process exits anyway — the
  // container's stop timeout would do the same, less tidily.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('{signal} received, draining', { component: 'worker-sandbox/server', signal });
    const deadline = setTimeout(() => {
      console.error(
        `[worker-sandbox] shutdown did not finish in ${SHUTDOWN_DEADLINE_MS}ms; exiting`
      );
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void (async () => {
      await server.drain();
      await browser?.shutdown();
      await charts?.shutdown();
      vault.close();
      logger.info('stopped', { component: 'worker-sandbox/server' });
      await logger.flush();
      await closeDatabase();
      process.exit(0);
    })().catch((error: unknown) => {
      console.error('[worker-sandbox] shutdown failed:', error);
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
