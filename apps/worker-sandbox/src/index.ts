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
 * What this worker does for an organization is that organization's own
 * choice, made in its settings (admin → Settings → Sandbox: the browser,
 * charts, code workspaces, services beside them, scripts, and whether
 * scripts may run on this container's network) and read per request
 * (features.ts). What this worker CAN do is found once at boot below and
 * reported on /health; the environment names only where things are and
 * what they are called, never whether a feature is on.
 *
 * Env contract:
 *   SANDBOX_WORKER_API_KEY — required; comma-separated bearer keys the web
 *     app must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   SANDBOX_WORKER_PORT    — listen port, default 8092.
 *   SANDBOX_DATA_DIR       — where staged files live on disk, default /data.
 *   DATABASE_URL           — the shared Postgres, for file metadata and
 *     each organization's settings.
 *   SANDBOX_BROWSER_EXECUTABLE — optional Chromium binary for the headless
 *     browser behind the sandbox_browser_* tools (browser.ts); by default
 *     playwright-core resolves its own installed headless shell. The
 *     browser launches lazily, on an organization's first page.
 *   SANDBOX_MERMAID_BUNDLE — optional path to Mermaid's browser bundle,
 *     for charts (Mermaid text to an SVG, PNG or PDF — charts.ts) drawn
 *     in a Chromium of their own with no network at all; by default the
 *     one this package depends on. Without a bundle, charts are a
 *     capability this worker lacks, and /health says so.
 *   SANDBOX_WORKSPACES_DIR — where code workspaces' checkouts live
 *     (workspaces.ts), default /workspaces (its own volume, apart from the
 *     staged-file disk). The process should run as root so each caller's
 *     commands can be dropped to their own uid (docker/sandbox-entrypoint.sh
 *     does exactly that); without root it still works, unisolated, and
 *     says so below. Root that cannot drop a command runs nobody's: the
 *     capability is reported missing rather than every caller run as root.
 *   SANDBOX_ENV_SECRETS_KEY — seals workspace environment secrets; falls
 *     back to TOKEN_ENCRYPTION_KEY, and without either the env verbs are
 *     closed.
 *   SANDBOX_DOCKER_HOST — where the Docker engine for code project
 *     services (containers beside a checkout — services.ts) is:
 *     `unix:///var/run/docker.sock` (the default) or `tcp://host:port` for
 *     a socket proxy in front of it. An engine that does not answer at
 *     boot makes services a capability this worker lacks.
 *   SANDBOX_SERVICES_NETWORK — the internal Docker network services are
 *     created on and this worker joins, default `renkei-sandbox-services`.
 *   SANDBOX_CONTAINER_ID — this worker's own container, for joining that
 *     network; defaults to the hostname, which Docker sets to the
 *     container id. Unset and not a container (a developer's checkout),
 *     services are reached at their bridge address directly.
 *   SANDBOX_SERVICE_MEMORY — each service container's memory ceiling,
 *     default 1g; SANDBOX_SERVICE_PIDS its process ceiling, default 512.
 *   SANDBOX_PYTHON — the interpreter for scripts over staged files
 *     (scripts.ts, sandbox_run_python); by default the image's own
 *     environment with the data libraries (/opt/sandbox-python), else the
 *     `python3` on the PATH. None found makes scripts a capability this
 *     worker lacks. A run is started with NO network — `unshare --net` as
 *     root (CAP_SYS_ADMIN), else a user namespace of the caller's own
 *     (`unshare -Un`, unprivileged user namespaces). Where neither works
 *     a run would have this container's network, and is served only to
 *     an organization whose settings accept that (every result and the
 *     tool's description then say so), because the tool promises the
 *     model there is no network.
 *   SANDBOX_RUNS_DIR — where a run's throwaway directory is made,
 *     default /runs (no volume: nothing here outlives its run).
 *   SANDBOX_SCRIPT_MEMORY — a run's address-space ceiling, default 2g.
 *   SANDBOX_RUN_AS_WORKER — read by the image's entrypoint, not here:
 *     `true` starts this process as the unprivileged `worker` account
 *     (no uid isolation for anyone's commands) for a deployment where no
 *     organization will ever have workspaces or scripts on.
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
import { configuredDirectory } from './configured-path';
import type { SandboxCapabilities } from './features';
import { watchLogLevel } from '@renkei/settings';

/**
 * The most a shutdown may take end to end. Inside the 30s stop grace
 * docker-compose.yaml gives this container, with room for the drain's
 * own wait and the browser's close.
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

function fatal(message: string): never {
  console.error(`FATAL [worker-sandbox]: ${JSON.stringify(message)}`);
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

  // Nothing this process creates from here on is readable by the uids a
  // caller's commands run as: a staged file, a log, a lock.
  process.umask(0o077);

  // CAPABILITIES — what this worker can do, found once here and reported
  // on /health. Which organization gets which feature is a separate
  // question, answered per request from that organization's settings
  // (features.ts); nothing here is a switch any more.
  const problems: SandboxCapabilities['problems'] = {};
  let uidIsolation: SandboxCapabilities['uidIsolation'] = 'unisolated';
  // Whether a caller's command can be run here at all: as the worker user
  // (a developer's machine), or dropped from root to the caller's own uid.
  // Root that CANNOT drop never runs anyone's command: that would run
  // every caller's commands as root.
  let commandsPossible = true;
  if (!canIsolateByUid()) {
    logger.warn(
      'this process is not root: a workspace command or a script runs as the worker user with NO per-caller isolation — fine for one developer, wrong for a shared deployment',
      { component: 'worker-sandbox/workspaces' }
    );
  } else {
    const problem = await verifyUidIsolation();
    if (problem) {
      commandsPossible = false;
      const why =
        `this process is root, but a command cannot be dropped to a caller's uid: ${problem}. ` +
        'The sandbox image (docker/Dockerfile, target sandbox) supplies setpriv from util-linux, and the container needs CAP_SETUID, CAP_SETGID and CAP_SETPCAP (Docker grants them by default).';
      problems.workspaces = why;
      problems.scripts = why;
      logger.error('workspaces and scripts are unavailable: {problem}', {
        component: 'worker-sandbox/workspaces',
        problem: why,
      });
    } else {
      uidIsolation = 'per_caller';
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
  // organization's allowed images. Available when the engine answers now
  // — a socket that is not mounted would otherwise show up as a failed
  // start on the first service anyone asks for. A deployment without an
  // engine is the common case, so a missing one is a capability the
  // health answer lacks, not a failed boot.
  let services: ServiceManager | null = null;
  if (!commandsPossible) {
    problems.services = 'commands cannot be run for a caller here (see workspaces)';
  } else {
    let engine: DockerClient;
    let memoryBytes: number;
    try {
      engine = new DockerClient(parseDockerHost(process.env.SANDBOX_DOCKER_HOST));
      memoryBytes = parseMemoryBytes(process.env.SANDBOX_SERVICE_MEMORY, 1_073_741_824);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
    const pidsLimit = Number(process.env.SANDBOX_SERVICE_PIDS ?? '512');
    if (!Number.isInteger(pidsLimit) || pidsLimit <= 0) {
      fatal(`SANDBOX_SERVICE_PIDS is not a usable count: ${process.env.SANDBOX_SERVICE_PIDS}`);
    }
    try {
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
      problems.services =
        `the Docker engine could not be prepared: ${error instanceof Error ? error.message : String(error)}. ` +
        'Mount the engine socket into this container through a socket proxy (docker-compose.yaml, worker-sandbox) or point SANDBOX_DOCKER_HOST at one.';
      logger.info('services unavailable: {problem}', {
        component: 'worker-sandbox/services',
        problem: problems.services,
      });
    }
  }

  // Scripts over staged files: a caller's Python, run as their uid in a
  // throwaway directory with no network. The interpreter and its
  // libraries are checked now, so a missing one is known here rather than
  // a traceback on the first script anyone runs; and whether a run can be
  // started without a network is found now, once. Whether an organization
  // may run scripts on this container's network when it cannot is that
  // organization's own switch, asked per request (features.ts).
  let scripts: ScriptRunner | null = null;
  const isolation = await verifyNetworkIsolation();
  if (commandsPossible) {
    let python: string | null;
    try {
      python = await resolvePython(process.env.SANDBOX_PYTHON);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
    const probed = python ? await probePython(python) : null;
    if (!python || !probed) {
      problems.scripts = python
        ? `${python} does not run; point SANDBOX_PYTHON at a working interpreter`
        : 'no Python interpreter was found: the sandbox image (docker/Dockerfile, target sandbox) installs one at /opt/sandbox-python, or point SANDBOX_PYTHON at one';
      logger.info('scripts unavailable: {problem}', {
        component: 'worker-sandbox/scripts',
        problem: problems.scripts,
      });
    } else {
      let memoryBytes: number;
      try {
        memoryBytes = scriptMemoryBytes(process.env.SANDBOX_SCRIPT_MEMORY);
      } catch (error) {
        fatal(error instanceof Error ? error.message : String(error));
      }
      const runner = new ScriptRunner({
        db: dbResult.val,
        runsRoot: configuredDirectory('SANDBOX_RUNS_DIR', '/runs'),
        python,
        networkIsolation: isolation.mode,
        memoryBytes,
        maxFileBytes: orgMaxFileBytes,
      });
      const removed = await runner.prepare();
      scripts = runner;
      if (isolation.mode === null) {
        // Said once, here: an operator reading the boot log sees the
        // cause and the remedy. Such a run is served only to an
        // organization that has allowed scripts on this container's
        // network, and every result and the tool's description say so.
        problems.scripts = `no run can be started without a network (${isolation.problems.join('; ')}): served only to an organization that allows scripts on this container's network — give the container CAP_SYS_ADMIN or allow unprivileged user namespaces (docker-compose.yaml, worker-sandbox) to isolate them instead`;
        logger.warn('scripts have no network isolation: {problem}', {
          component: 'worker-sandbox/scripts',
          problem: problems.scripts,
        });
      }
      logger.info(
        'scripts available: {python} {version} with {libraries}; network {network}; memory {memory} bytes per run{removed}',
        {
          component: 'worker-sandbox/scripts',
          python,
          version: probed.version,
          libraries: probed.libraries.length ? probed.libraries.join(', ') : 'no data libraries',
          network:
            isolation.mode === 'netns'
              ? 'none per run (network namespace, as root)'
              : isolation.mode === 'userns'
                ? 'none per run (user namespace, as the caller)'
                : 'the container’s, for organizations that allow it (NOT ISOLATED)',
          memory: memoryBytes,
          removed: removed
            ? `; ${removed} stale run director${removed === 1 ? 'y' : 'ies'} removed`
            : '',
        }
      );
    }
  }

  const port = Number(process.env.SANDBOX_WORKER_PORT ?? '8092');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`SANDBOX_WORKER_PORT is not a usable port: ${process.env.SANDBOX_WORKER_PORT}`);
  }

  // The browser launches lazily on the first navigate, so having it costs
  // nothing until an organization with it on actually opens a page. The
  // secret vault holds a browser secret's key between an unlock and its
  // expiry — on the shared data disk, sealed, so every replica can type
  // it and a restart does not lock it; in this process's memory when
  // there is no key to seal with.
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
  let charts: ChartRenderer | null = new ChartRenderer();
  if (!charts.mermaidBundle) {
    charts = null;
    problems.charts =
      'the Mermaid bundle was not found: install this package’s dependencies (mermaid) or point SANDBOX_MERMAID_BUNDLE at mermaid.min.js';
    logger.info('charts unavailable: {problem}', {
      component: 'worker-sandbox/charts',
      problem: problems.charts,
    });
  }

  const server = createSandboxServer({
    db: dbResult.val,
    apiKeys,
    browser,
    vault,
    charts,
    workspaces: commandsPossible,
    services,
    scripts,
    scriptsNetworkIsolation: isolation.mode,
    uidIsolation,
    capabilityProblems: problems,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info(
      'started {application} {version} on port {port} — can do: browser, charts {charts}, workspaces {workspaces}, services {services}, scripts {scripts}; each organization turns its own on in Settings',
      {
        component: 'worker-sandbox/server',
        port,
        charts: charts ? 'yes' : 'no',
        workspaces: commandsPossible
          ? uidIsolation === 'per_caller'
            ? 'yes, per-caller uids'
            : 'yes, UNISOLATED'
          : 'no',
        services: services ? 'yes' : 'no',
        scripts: scripts
          ? `yes${uidIsolation === 'per_caller' ? ', per-caller uids' : ', UNISOLATED by uid'}${isolation.mode ? '' : ', WITHOUT network isolation'}`
          : 'no',
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
