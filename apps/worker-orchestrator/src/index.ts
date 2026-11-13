/**
 * The sandbox orchestrator — the process that makes, suspends, resumes
 * and removes sandboxes (docs/sandbox-orchestrator-design.md), and the
 * only one that holds the means to: the Docker engine's socket locally,
 * the sandbox group's data-plane role on Azure. It runs nobody's code.
 *
 * Callers (the web app, the queue worker) ask it where a scope's sandbox
 * is before each call (server.ts); a timer applies the idle rules and
 * the housekeeping (the orchestrator's `sweep`). Any number of these may
 * run: every decision is a compare-and-set on the `sandboxes` table.
 *
 * Env contract (the provider's own variables are in
 * packages/sandbox-orchestrator/src/config.ts):
 *   SANDBOX_ORCHESTRATOR_API_KEY — required; comma-separated bearer keys
 *     callers present.
 *   SANDBOX_ORCHESTRATOR_PORT    — listen port, default 8097.
 *   SANDBOX_WORKER_API_KEY       — required; the deployment's sandbox
 *     key. Each sandbox's own key is derived from it, so it is never
 *     handed to a sandbox.
 *   DATABASE_URL                 — the shared Postgres (`sandboxes`).
 *   SANDBOX_SWEEP_SECONDS        — how often the idle rules run, default 30.
 */

import { checkDataStore, closeDataStore, getDataStore } from '@renkei/db';
import {
  Orchestrator,
  idleRules,
  providerFromEnv,
  templateEnv,
  type SandboxProvider,
} from '@renkei/sandbox-orchestrator';
import { watchLogLevel } from '@renkei/settings';
import { schedulePeriodicSweep } from '@renkei/worker-loop';
import { createOrchestratorServer } from './server';
import { attachPersistentLogging, logger } from './logger';

const COMPONENT = 'worker-orchestrator';

function fatal(message: string): never {
  console.error(`FATAL [worker-orchestrator]: ${JSON.stringify(message)}`);
  process.exit(1);
}

function keys(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  await attachPersistentLogging();
  watchLogLevel(logger);

  const apiKeys = keys('SANDBOX_ORCHESTRATOR_API_KEY');
  if (apiKeys.length === 0) {
    fatal('SANDBOX_ORCHESTRATOR_API_KEY is required (comma-separated bearer keys)');
  }
  // The first key is the one sandboxes' keys are derived from; a rotation
  // of it gives every sandbox made afterwards a new key.
  const masterKey = keys('SANDBOX_WORKER_API_KEY')[0];
  if (!masterKey) fatal('SANDBOX_WORKER_API_KEY is required (the deployment’s sandbox key)');

  const ready = checkDataStore();
  if (!ready.ok) fatal(`database unavailable: ${String(ready.err)}`);

  const portEnv = process.env.SANDBOX_ORCHESTRATOR_PORT;
  const port = Number(portEnv ?? '8097');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal(`SANDBOX_ORCHESTRATOR_PORT is not a usable port: ${portEnv}`);
  }
  const sweepSeconds = Number(process.env.SANDBOX_SWEEP_SECONDS ?? '30');
  if (!Number.isFinite(sweepSeconds) || sweepSeconds <= 0) {
    fatal(`SANDBOX_SWEEP_SECONDS is not a usable interval: ${process.env.SANDBOX_SWEEP_SECONDS}`);
  }

  let provider: SandboxProvider;
  let rules: ReturnType<typeof idleRules>;
  try {
    provider = await providerFromEnv(process.env);
    rules = idleRules(process.env);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
  try {
    await provider.check();
  } catch (error) {
    // Not fatal: an engine that is restarting comes back, and a call made
    // meanwhile says why it could not be served.
    logger.error(
      'the {provider} sandbox provider did not answer at boot: {error}; no sandbox can be made until it does',
      {
        component: COMPONENT,
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }

  const store = () => getDataStore().sandboxes;
  const orchestrator = new Orchestrator({
    provider,
    store,
    masterKey,
    env: templateEnv(process.env),
    logger,
    ...rules,
  });

  const stopSweep = schedulePeriodicSweep(
    logger,
    'sandbox lifecycle',
    `${COMPONENT}/sweep`,
    sweepSeconds * 1000,
    async () => {
      const report = await orchestrator.sweep();
      const acted =
        report.suspended + report.removed + report.recovered + report.orphans + report.failures;
      if (acted > 0) {
        logger.info(
          'sandbox sweep: {suspended} suspended, {removed} removed, {recovered} recovered, {orphans} machines without a record removed, {failures} failed',
          { component: `${COMPONENT}/sweep`, ...report }
        );
      }
    }
  );

  const server = createOrchestratorServer({
    apiKeys,
    orchestrator,
    store,
    masterKey,
    providerName: provider.name,
  });
  server.listen(port, '0.0.0.0', () => {
    logger.info(
      'started {application} {version}, listening on port {port}; sandboxes are made by {provider}, suspended after {suspendMinutes} idle minutes and removed after {deleteHours} idle hours',
      {
        component: `${COMPONENT}/server`,
        port,
        provider: provider.name,
        suspendMinutes: rules.idleSuspendMs / 60_000,
        deleteHours: rules.idleDeleteMs / 3_600_000,
      }
    );
  });

  const shutdown = (signal: string): void => {
    logger.info('received {signal}; closing the server, then stopping', {
      component: `${COMPONENT}/server`,
      signal,
    });
    stopSweep();
    // Sandboxes are left as they are: the next orchestrator carries on from the table.
    server.close(() => {
      void (async () => {
        await logger.flush();
        await closeDataStore();
        process.exit(0);
      })();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
