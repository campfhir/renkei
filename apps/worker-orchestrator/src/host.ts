/**
 * The orchestrator in force, built from the organization's stored
 * configuration and rebuilt when that changes — an operator saving the
 * Sandboxes page takes effect within a quarter of a minute, with no
 * restart. Until a usable configuration is stored there is no
 * orchestrator, and every call says why in the operator's own terms.
 *
 * Sandboxes already made are not touched by a change: the next
 * orchestrator reads the same `sandboxes` table. (Changing WHERE
 * sandboxes are made leaves the old provider's machines behind for an
 * operator to remove; their scopes get new sandboxes.)
 */

import { createHash } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import {
  Orchestrator,
  OrchestratorError,
  type ArchiveOptions,
  type OrchestratorLogger,
} from '@renkei/sandbox-orchestrator';
import { buildFromStored, type BuildDeps, type StoredRow } from './stored';

const COMPONENT = 'worker-orchestrator/config';
export const RELOAD_MS = 15_000;

export interface HostOptions {
  /** The stored row now; null when none. Throws when it cannot be read. */
  read: () => Promise<StoredRow | null>;
  masterKey: string;
  logger: OrchestratorLogger;
  /** Where evicted sandboxes' archives are kept; absent, an eviction removes the work. */
  archives?: ArchiveOptions;
  deps?: BuildDeps;
}

export class OrchestratorHost {
  private orchestrator: Orchestrator | null = null;
  private fingerprint: string | null = null;
  private problem = 'the sandbox configuration has not been read yet';
  private providerName: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostOptions) {}

  /** The orchestrator, or a refusal that says why there is none. */
  current(): Orchestrator {
    if (!this.orchestrator) throw new OrchestratorError('provider', this.problem);
    return this.orchestrator;
  }

  /** The orchestrator when there is one, for work that simply waits otherwise (the sweep). */
  maybe(): Orchestrator | null {
    return this.orchestrator;
  }

  status(): { provider: string | null; problem: string | null } {
    return { provider: this.providerName, problem: this.orchestrator ? null : this.problem };
  }

  /** Read the stored configuration and, when it has changed, build from it. */
  async reload(): Promise<void> {
    let row: StoredRow | null;
    try {
      row = await this.options.read();
    } catch (error) {
      // Whatever was in force stays in force: a database blip changes nothing.
      this.options.logger.warn(
        'the sandbox configuration could not be read: {error}; the one in force is kept',
        { component: COMPONENT, error: error instanceof Error ? error.message : String(error) }
      );
      return;
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    if (fingerprint === this.fingerprint) return;
    const built = await buildFromStored(row, this.options.deps);
    this.fingerprint = fingerprint;
    if (typeof built === 'string') {
      this.orchestrator = null;
      this.providerName = null;
      this.problem = built;
      this.options.logger.warn('no sandbox can be made: {problem}', {
        component: COMPONENT,
        problem: built,
      });
      return;
    }
    this.orchestrator = new Orchestrator({
      provider: built.provider,
      store: () => getDataStore().sandboxes,
      masterKey: this.options.masterKey,
      env: built.env,
      callbackUrl: built.callbackUrl,
      logger: this.options.logger,
      idleSuspendMs: built.idleSuspendMs,
      idleDeleteMs: built.idleDeleteMs,
      ...(this.options.archives ? { archives: this.options.archives } : {}),
    });
    this.providerName = built.provider.name;
    this.options.logger.info(
      'sandboxes are made by {provider}, suspended after {suspendMinutes} idle minutes and evicted after {evictHours} idle hours, as the organization’s settings now say',
      {
        component: COMPONENT,
        provider: built.provider.name,
        suspendMinutes: built.idleSuspendMs / 60_000,
        evictHours: built.idleDeleteMs / 3_600_000,
      }
    );
  }

  start(): void {
    this.timer = setInterval(() => void this.reload(), RELOAD_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
