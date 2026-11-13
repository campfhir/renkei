/**
 * The sandbox orchestrator: which scope has a sandbox, where it is in its
 * life, and when it goes (docs/sandbox-orchestrator-design.md).
 *
 * A sandbox is made the first time a call is made for its scope
 * (`ensure`), suspended when nothing has called it for a while, resumed
 * on the next call, and removed once it has been idle for a day
 * (`sweep`). The provider (provider.ts) does the making; the `sandboxes`
 * table is the record; this is the only thing that decides.
 *
 * Several orchestrators may run at once, and one may die half way
 * through anything. So:
 *
 *  - every change of state is a compare-and-set on the row
 *    (`sandboxes.transition`): whoever moves it does the work, everyone
 *    else waits for the row to say it is done;
 *  - a scope has at most one sandbox that is not deleted (the table's
 *    partial unique index), so two first calls make one sandbox;
 *  - a row left in a transitional state for longer than any transition
 *    takes is put right by the sweep from what the provider says;
 *  - a machine the provider has whose row is gone is removed by the
 *    sweep, found by the id it is labelled with.
 *
 * A row is trusted for a short while (`verifyAfterMs`); past that, or
 * when a caller says its last call did not connect, the provider is
 * asked before the row is believed — which is how a sandbox the platform
 * suspended or removed by itself is noticed.
 */

import { randomUUID } from 'node:crypto';
import type { SandboxRecord, SandboxState, SandboxStore } from '@renkei/db';
import { sandboxApiKey } from './keys';
import {
  SANDBOX_WORKER_PORT,
  type ProviderSandbox,
  type SandboxProvider,
  type SandboxSpec,
} from './provider';
import { isRouteKey, sandboxKindOf } from './scope';

export interface OrchestratorLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

export interface OrchestratorOptions {
  provider: SandboxProvider;
  store: () => SandboxStore;
  /** The deployment's sandbox key; each sandbox's own is derived from it (keys.ts). */
  masterKey: string;
  /** What every sandbox's worker is started with, besides what the orchestrator sets itself. */
  env: Record<string, string>;
  logger: OrchestratorLogger;
  /** Suspend a sandbox nothing has called for this long. */
  idleSuspendMs?: number;
  /** Remove a sandbox nothing has called for this long. */
  idleDeleteMs?: number;
  /** How long a sandbox gets to answer after it is made or resumed. */
  readyTimeoutMs?: number;
  /** A transition older than this is taken for abandoned. */
  staleTransitionMs?: number;
  /** How long a `running` row is believed without asking the provider. */
  verifyAfterMs?: number;
  /** How long a `deleted` row is kept. */
  keepDeletedMs?: number;
  /** How many sandboxes one sweep handles per rule. */
  sweepBatch?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /**
   * Whether the worker at `address` answers, and what it says it can do:
   * the `/health` body, or null while it does not answer.
   */
  probe?: (address: string) => Promise<unknown | null>;
}

export const DEFAULT_IDLE_SUSPEND_MS = 15 * 60_000;
export const DEFAULT_IDLE_DELETE_MS = 24 * 60 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_TRANSITION_MS = 10 * 60_000;
const DEFAULT_VERIFY_AFTER_MS = 30_000;
const DEFAULT_KEEP_DELETED_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_SWEEP_BATCH = 100;
const POLL_MS = 500;
const PROBE_TIMEOUT_MS = 2_000;
const COMPONENT = 'sandbox-orchestrator';

export type OrchestratorErrorType =
  /** The key does not name a scope. */
  | 'bad_request'
  /** The sandbox is being made or resumed and did not answer in time; try again. */
  | 'starting'
  /** The provider refused or failed. */
  | 'provider';

export class OrchestratorError extends Error {
  constructor(
    readonly type: OrchestratorErrorType,
    message: string
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

/** Where a scope's sandbox answers, and the key it takes. */
export interface SandboxEndpoint {
  sandboxId: string;
  url: string;
  key: string;
}

export interface SweepReport {
  suspended: number;
  removed: number;
  /** Abandoned transitions put right. */
  recovered: number;
  /** Machines with no row, removed. */
  orphans: number;
  purged: number;
  failures: number;
}

async function defaultProbe(address: string): Promise<unknown | null> {
  try {
    const response = await fetch(`${address}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRANSITIONAL: SandboxState[] = ['provisioning', 'resuming', 'suspending', 'deleting'];

export class Orchestrator {
  private readonly provider: SandboxProvider;
  private readonly store: () => SandboxStore;
  private readonly logger: OrchestratorLogger;
  private readonly idleSuspendMs: number;
  private readonly idleDeleteMs: number;
  private readonly readyTimeoutMs: number;
  private readonly staleTransitionMs: number;
  private readonly verifyAfterMs: number;
  private readonly keepDeletedMs: number;
  private readonly sweepBatch: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly probe: (address: string) => Promise<unknown | null>;
  /** One `ensure` at a time per scope in this process; the row settles it between processes. */
  private readonly inflight = new Map<string, Promise<SandboxEndpoint>>();
  private lastHealth: unknown | null = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.logger = options.logger;
    this.idleSuspendMs = options.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
    this.idleDeleteMs = options.idleDeleteMs ?? DEFAULT_IDLE_DELETE_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.staleTransitionMs = options.staleTransitionMs ?? DEFAULT_STALE_TRANSITION_MS;
    this.verifyAfterMs = options.verifyAfterMs ?? DEFAULT_VERIFY_AFTER_MS;
    this.keepDeletedMs = options.keepDeletedMs ?? DEFAULT_KEEP_DELETED_MS;
    this.sweepBatch = options.sweepBatch ?? DEFAULT_SWEEP_BATCH;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newId = options.newId ?? randomUUID;
    this.probe = options.probe ?? defaultProbe;
  }

  /** What the last sandbox to come up said on `/health`: its capabilities, for the callers' feature checks. */
  health(): unknown | null {
    return this.lastHealth;
  }

  private at(): Date {
    return new Date(this.now());
  }

  private attrs(row: SandboxRecord): Record<string, unknown> {
    return {
      component: COMPONENT,
      sandbox: row.id,
      scope: row.routeKey,
      kind: row.kind,
      provider: row.provider,
    };
  }

  private endpointOf(row: SandboxRecord, address: string): SandboxEndpoint {
    return {
      sandboxId: row.id,
      url: address,
      key: sandboxApiKey(this.options.masterKey, row.id),
    };
  }

  private specOf(row: SandboxRecord): SandboxSpec {
    return {
      sandboxId: row.id,
      kind: row.kind,
      env: {
        ...this.options.env,
        // Set last: nothing in the template can stand in for these.
        SANDBOX_WORKER_API_KEY: sandboxApiKey(this.options.masterKey, row.id),
        SANDBOX_WORKER_PORT: String(SANDBOX_WORKER_PORT),
        SANDBOX_ORCHESTRATED: '1',
        SANDBOX_INSTANCE_ID: row.id,
      },
      idleSuspendSeconds: Math.round(this.idleSuspendMs / 1000),
      idleDeleteSeconds: Math.round(this.idleDeleteMs / 1000),
    };
  }

  /**
   * The scope's sandbox, running: made if it has none, resumed if it is
   * suspended, waited for if another call is already bringing it up.
   * `verify` asks the provider even where the row was checked lately —
   * for a caller whose last call did not connect.
   */
  ensure(routeKey: string, options: { verify?: boolean } = {}): Promise<SandboxEndpoint> {
    if (!isRouteKey(routeKey)) {
      return Promise.reject(new OrchestratorError('bad_request', 'not a sandbox scope'));
    }
    const running = this.inflight.get(routeKey);
    if (running) return running;
    const made = this.ensureOnce(routeKey, options.verify === true).finally(() => {
      this.inflight.delete(routeKey);
    });
    this.inflight.set(routeKey, made);
    return made;
  }

  private async ensureOnce(routeKey: string, verify: boolean): Promise<SandboxEndpoint> {
    const store = this.store();
    const deadline = this.now() + this.readyTimeoutMs;
    let mustVerify = verify;
    for (;;) {
      const row = await store.live(routeKey);
      if (!row) {
        const claimed = await store.claim({
          id: this.newId(),
          routeKey,
          kind: sandboxKindOf(routeKey),
          provider: this.provider.name,
          at: this.at(),
        });
        // Null: another call claimed it first; read theirs.
        if (claimed) return this.provision(claimed);
        continue;
      }
      if (row.state === 'running') {
        const stale = this.now() - row.verifiedAt.getTime() > this.verifyAfterMs;
        if (mustVerify || stale || !row.address) {
          const settled = await this.verifyRunning(row);
          if (!settled) {
            // The row has moved (suspended, deleted): look again, without asking twice.
            mustVerify = false;
            if (this.now() > deadline) throw this.notReady(row);
            continue;
          }
          await store.touch(row.id, this.at());
          return this.endpointOf(row, settled);
        }
        await store.touch(row.id, this.at());
        return this.endpointOf(row, row.address);
      }
      if (row.state === 'suspended') {
        const mine = await store.transition({
          id: row.id,
          from: ['suspended'],
          to: 'resuming',
          at: this.at(),
        });
        if (mine) return this.resume(row);
        continue;
      }
      // Someone is making, resuming, suspending or removing it. An
      // abandoned transition is the sweep's to put right; here it is
      // put right at once rather than waited out.
      if (this.now() - row.stateChangedAt.getTime() > this.staleTransitionMs) {
        await this.recover(row);
        continue;
      }
      if (this.now() > deadline) throw this.notReady(row);
      await this.sleep(POLL_MS);
    }
  }

  private notReady(row: SandboxRecord): OrchestratorError {
    return new OrchestratorError(
      'starting',
      `the sandbox is still ${row.state} and has not answered yet; try again shortly`
    );
  }

  /**
   * A `running` row, checked against the provider: its address when the
   * provider agrees, null when the row was moved to what the provider
   * says instead (suspended by the platform, gone) or is between states.
   */
  private async verifyRunning(row: SandboxRecord): Promise<string | null> {
    const store = this.store();
    let seen: ProviderSandbox | null;
    try {
      seen = row.providerId ? await this.provider.inspect(row.providerId) : null;
    } catch (error) {
      throw new OrchestratorError('provider', messageOf(error));
    }
    if (!seen || seen.state === 'failed') {
      if (seen && row.providerId) await this.provider.destroy(row.providerId).catch(() => undefined);
      await store.transition({
        id: row.id,
        from: ['running'],
        to: 'deleted',
        at: this.at(),
        address: null,
        error: seen ? 'the provider says it will not run again' : 'the provider no longer has it',
      });
      this.logger.warn(
        'sandbox for {scope} is gone at the provider; a new one is made on this call, and what the old one held is not carried over',
        this.attrs(row)
      );
      return null;
    }
    if (seen.state === 'suspended') {
      // The platform's own idle rule got there first.
      await store.transition({
        id: row.id,
        from: ['running'],
        to: 'suspended',
        at: this.at(),
        address: null,
      });
      return null;
    }
    if (seen.state !== 'running' || !seen.address) {
      await this.sleep(POLL_MS);
      return null;
    }
    if (seen.address !== row.address) {
      // A restarted container may come back at another address.
      await store.transition({
        id: row.id,
        from: ['running'],
        to: 'running',
        at: this.at(),
        address: seen.address,
      });
    } else {
      await store.verified(row.id, this.at());
    }
    return seen.address;
  }

  /** Poll the provider, then the worker itself, until the sandbox answers. */
  private async waitReady(providerId: string): Promise<string> {
    const deadline = this.now() + this.readyTimeoutMs;
    for (;;) {
      const seen = await this.provider.inspect(providerId);
      if (!seen) throw new OrchestratorError('provider', 'the provider lost the sandbox');
      if (seen.state === 'failed') {
        throw new OrchestratorError('provider', 'the sandbox failed to start');
      }
      if (seen.state === 'suspended') {
        throw new OrchestratorError('provider', 'the sandbox stopped before it answered');
      }
      if (seen.state === 'running' && seen.address) {
        const health = await this.probe(seen.address);
        if (health !== null) {
          this.lastHealth = health;
          return seen.address;
        }
      }
      if (this.now() > deadline) {
        throw new OrchestratorError(
          'starting',
          'the sandbox did not answer in time; try again shortly'
        );
      }
      await this.sleep(POLL_MS);
    }
  }

  private async provision(row: SandboxRecord): Promise<SandboxEndpoint> {
    const store = this.store();
    let providerId: string | null = null;
    try {
      ({ providerId } = await this.provider.create(this.specOf(row)));
      // Recorded before it answers, so an orchestrator that dies here leaves a row that names the machine.
      await store.transition({
        id: row.id,
        from: ['provisioning'],
        to: 'provisioning',
        at: this.at(),
        providerId,
      });
      const address = await this.waitReady(providerId);
      const mine = await store.transition({
        id: row.id,
        from: ['provisioning'],
        to: 'running',
        at: this.at(),
        address,
      });
      if (!mine) throw new OrchestratorError('provider', 'the sandbox was removed while starting');
      this.logger.info('sandbox for {scope} is up on {provider}', this.attrs(row));
      return this.endpointOf(row, address);
    } catch (error) {
      if (providerId) await this.provider.destroy(providerId).catch(() => undefined);
      await store.transition({
        id: row.id,
        from: ['provisioning'],
        to: 'deleted',
        at: this.at(),
        address: null,
        error: messageOf(error),
      });
      this.logger.error(
        'sandbox for {scope} could not be made on {provider}: {error}; the call it was for was not served',
        { ...this.attrs(row), error: messageOf(error) }
      );
      throw error instanceof OrchestratorError
        ? error
        : new OrchestratorError('provider', messageOf(error));
    }
  }

  private async resume(row: SandboxRecord): Promise<SandboxEndpoint> {
    const store = this.store();
    const providerId = row.providerId;
    try {
      if (!providerId) throw new OrchestratorError('provider', 'the sandbox has no machine');
      await this.provider.resume(providerId);
      const address = await this.waitReady(providerId);
      const mine = await store.transition({
        id: row.id,
        from: ['resuming'],
        to: 'running',
        at: this.at(),
        address,
      });
      if (!mine) throw new OrchestratorError('provider', 'the sandbox was removed while resuming');
      await store.touch(row.id, this.at());
      this.logger.info('sandbox for {scope} resumed', this.attrs(row));
      return this.endpointOf(row, address);
    } catch (error) {
      // Gone at the provider: the next call makes a new one. Otherwise it
      // is still suspended there, and the next call tries again.
      const seen = providerId ? await this.provider.inspect(providerId).catch(() => undefined) : null;
      const gone = seen === null || seen?.state === 'failed';
      if (gone && providerId) await this.provider.destroy(providerId).catch(() => undefined);
      await store.transition({
        id: row.id,
        from: ['resuming'],
        to: gone ? 'deleted' : 'suspended',
        at: this.at(),
        address: null,
        error: messageOf(error),
      });
      this.logger.error(
        'sandbox for {scope} could not be resumed: {error}; the call it was for was not served',
        { ...this.attrs(row), error: messageOf(error) }
      );
      throw error instanceof OrchestratorError
        ? error
        : new OrchestratorError('provider', messageOf(error));
    }
  }

  /**
   * Put an abandoned transition right from what the provider says: a
   * sandbox that was being suspended or resumed is whatever it now is;
   * one that was being made or removed is removed.
   */
  private async recover(row: SandboxRecord): Promise<void> {
    const store = this.store();
    const from: SandboxState[] = [row.state];
    const providerId = row.providerId ?? (await this.findMachine(row.id));
    if (row.state === 'suspending' || row.state === 'resuming') {
      const seen = providerId ? await this.provider.inspect(providerId) : null;
      if (seen?.state === 'running' && seen.address) {
        await store.transition({
          id: row.id,
          from,
          to: 'running',
          at: this.at(),
          address: seen.address,
        });
        return;
      }
      if (seen && seen.state !== 'failed') {
        // Suspended, or still on its way there: a call that wants it resumes it.
        await store.transition({ id: row.id, from, to: 'suspended', at: this.at(), address: null });
        return;
      }
    }
    if (providerId) await this.provider.destroy(providerId);
    await store.transition({
      id: row.id,
      from,
      to: 'deleted',
      at: this.at(),
      address: null,
      ...(row.state === 'deleting' ? {} : { error: `abandoned while ${row.state}` }),
    });
  }

  /** The machine labelled with a sandbox's id, for a row that never recorded one. */
  private async findMachine(sandboxId: string): Promise<string | null> {
    const machines = await this.provider.list();
    return machines.find((machine) => machine.sandboxId === sandboxId)?.providerId ?? null;
  }

  /** Remove a scope's sandbox now, whatever it is doing; false when it has none. */
  async remove(routeKey: string, reason: string | null = null): Promise<boolean> {
    const row = await this.store().live(routeKey);
    if (!row) return false;
    return this.destroy(row, [row.state], reason);
  }

  private async destroy(
    row: SandboxRecord,
    from: SandboxState[],
    reason: string | null
  ): Promise<boolean> {
    const store = this.store();
    const mine = await store.transition({ id: row.id, from, to: 'deleting', at: this.at() });
    if (!mine) return false;
    const providerId = row.providerId ?? (await this.findMachine(row.id));
    // A failure here leaves the row `deleting`; the sweep finishes it.
    if (providerId) await this.provider.destroy(providerId);
    await store.transition({
      id: row.id,
      from: ['deleting'],
      to: 'deleted',
      at: this.at(),
      address: null,
      error: reason,
    });
    return true;
  }

  /**
   * One pass of the idle rules and the housekeeping. Safe to run from
   * several orchestrators at once, and to run again after any failure.
   */
  async sweep(): Promise<SweepReport> {
    const store = this.store();
    const report: SweepReport = {
      suspended: 0,
      removed: 0,
      recovered: 0,
      orphans: 0,
      purged: 0,
      failures: 0,
    };
    const now = this.now();
    const guard = async (row: SandboxRecord, what: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        report.failures += 1;
        this.logger.warn('sandbox for {scope} could not be {what}: {error}; it is tried again on the next sweep', {
          ...this.attrs(row),
          what,
          error: messageOf(error),
        });
      }
    };

    // Transitions nobody finished.
    const abandoned = await store.list({
      states: TRANSITIONAL,
      stateChangedBefore: new Date(now - this.staleTransitionMs),
      limit: this.sweepBatch,
    });
    for (const row of abandoned) {
      await guard(row, 'recovered', async () => {
        await this.recover(row);
        report.recovered += 1;
      });
    }

    // Idle for a day: gone, whether it was running or suspended.
    const expired = await store.list({
      states: ['running', 'suspended'],
      lastActiveBefore: new Date(now - this.idleDeleteMs),
      limit: this.sweepBatch,
    });
    for (const row of expired) {
      await guard(row, 'removed', async () => {
        if (await this.destroy(row, ['running', 'suspended'], null)) {
          report.removed += 1;
          this.logger.info(
            'sandbox for {scope} was removed after being idle since {idleSince}',
            { ...this.attrs(row), idleSince: row.lastActiveAt.toISOString() }
          );
        }
      });
    }

    // Idle for a while: suspended.
    const idleCut = new Date(now - this.idleSuspendMs);
    const idle = await store.list({
      states: ['running'],
      lastActiveBefore: idleCut,
      limit: this.sweepBatch,
    });
    for (const row of idle) {
      await guard(row, 'suspended', async () => {
        if (await this.suspendIdle(row, idleCut)) report.suspended += 1;
      });
    }

    // Machines whose row is gone.
    try {
      const graceCut = now - this.staleTransitionMs;
      for (const machine of await this.provider.list()) {
        if (!machine.sandboxId) continue;
        // Just made: its row may not have its name yet.
        if (machine.createdAt && machine.createdAt.getTime() > graceCut) continue;
        const row = await store.get(machine.sandboxId);
        if (row && row.state !== 'deleted') continue;
        await this.provider.destroy(machine.providerId);
        report.orphans += 1;
        this.logger.warn('a sandbox machine with no record ({machine}) was removed', {
          component: COMPONENT,
          machine: machine.providerId,
          sandbox: machine.sandboxId,
          provider: this.provider.name,
        });
      }
    } catch (error) {
      report.failures += 1;
      this.logger.warn(
        'the provider could not be asked for its sandboxes: {error}; machines with no record are left until the next sweep',
        { component: COMPONENT, provider: this.provider.name, error: messageOf(error) }
      );
    }

    report.purged = await store.purgeDeleted(new Date(now - this.keepDeletedMs));
    return report;
  }

  private async suspendIdle(row: SandboxRecord, idleCut: Date): Promise<boolean> {
    const store = this.store();
    const mine = await store.transition({
      id: row.id,
      from: ['running'],
      to: 'suspending',
      at: this.at(),
    });
    if (!mine) return false;
    // A call may have landed between the list and the claim: it keeps running.
    const fresh = await store.get(row.id);
    if (!row.providerId || !fresh || fresh.lastActiveAt.getTime() >= idleCut.getTime()) {
      await store.transition({ id: row.id, from: ['suspending'], to: 'running', at: this.at() });
      return false;
    }
    try {
      await this.provider.suspend(row.providerId);
    } catch (error) {
      await store.transition({ id: row.id, from: ['suspending'], to: 'running', at: this.at() });
      throw error;
    }
    await store.transition({
      id: row.id,
      from: ['suspending'],
      to: 'suspended',
      at: this.at(),
      address: null,
    });
    this.logger.info('sandbox for {scope} was suspended after being idle', this.attrs(row));
    return true;
  }
}
