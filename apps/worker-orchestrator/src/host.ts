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
  type DiskImageStatus,
  type OrchestratorErrorType,
  type OrchestratorLogger,
} from '@renkei/sandbox-orchestrator';
import {
  automaticImageOf,
  buildFromStored,
  startDiskImage,
  type BuildDeps,
  type ImageDeps,
  type StoredRow,
} from './stored';

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
  /**
   * Preparing the disk image for this build, where the setup leaves it to
   * the orchestrator (stored.ts automaticImageOf). Without it a setup that
   * pins no disk image makes nothing and says why.
   */
  image?: ImageDeps;
}

export class OrchestratorHost {
  private orchestrator: Orchestrator | null = null;
  private fingerprint: string | null = null;
  private problem = 'the sandbox configuration has not been read yet';
  /** `starting` while a disk image is prepared: a caller is told to try again shortly. */
  private problemType: OrchestratorErrorType = 'provider';
  /** The preparation the stored setup is waiting on, by its key; null when it pins its image or is not Azure. */
  private imageKey: string | null = null;
  private lastRow: StoredRow | null = null;
  /** The preparation this host is waiting on to finish, by key: it is waited on once, however it began. */
  private awaiting: string | null = null;
  private providerName: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostOptions) {}

  /** The orchestrator, or a refusal that says why there is none. */
  current(): Orchestrator {
    if (!this.orchestrator) throw new OrchestratorError(this.problemType, this.problem);
    return this.orchestrator;
  }

  /** The orchestrator when there is one, for work that simply waits otherwise (the sweep). */
  maybe(): Orchestrator | null {
    return this.orchestrator;
  }

  status(): { provider: string | null; problem: string | null; image: DiskImageStatus | null } {
    return {
      provider: this.providerName,
      problem: this.orchestrator ? null : this.problem,
      image:
        this.imageKey && this.options.image
          ? this.options.image.preparer.status(this.imageKey)
          : null,
    };
  }

  /**
   * Prepare the stored setup's disk image again — after a failed build,
   * when an operator asks from Organization → Sandboxes — and put the
   * orchestrator in force once it is ready. What it says now.
   */
  async prepareAgain(): Promise<ReturnType<OrchestratorHost['status']>> {
    const row = this.lastRow;
    const image = this.options.image;
    const automatic = row && image ? automaticImageOf(row, image.commit) : null;
    if (row && image && automatic && typeof automatic !== 'string') {
      void startDiskImage(row, automatic, image.preparer, this.options.deps, {
        again: true,
        ...(image.pollMs ? { pollMs: image.pollMs } : {}),
      })
        .catch(() => undefined)
        .finally(() => {
          this.fingerprint = null;
          void this.reload();
        });
      this.fingerprint = null;
      await this.reload();
    }
    return this.status();
  }

  private noOrchestrator(problem: string, type: OrchestratorErrorType = 'provider'): void {
    this.orchestrator = null;
    this.providerName = null;
    this.problem = problem;
    this.problemType = type;
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
    this.fingerprint = fingerprint;
    this.lastRow = row;

    // A setup that leaves the disk image to the orchestrator is put in
    // force only once the image for this build is Ready in its group.
    const image = this.options.image;
    const automatic = row?.enabled ? automaticImageOf(row, image?.commit ?? null) : null;
    this.imageKey = automatic && typeof automatic !== 'string' ? automatic.key : null;
    if (typeof automatic === 'string') {
      this.noOrchestrator(automatic);
      this.options.logger.warn('no sandbox can be made: {problem}', {
        component: COMPONENT,
        problem: automatic,
      });
      return;
    }
    let preparedDiskImage: string | null = null;
    if (row && automatic) {
      if (!image) {
        this.noOrchestrator(
          'this orchestrator cannot prepare a disk image; pin one on Organization → Sandboxes'
        );
        return;
      }
      const status = image.preparer.status(automatic.key);
      if (status?.state === 'failed') {
        this.noOrchestrator(
          `the disk image for build ${automatic.plan.build} could not be prepared — ${status.detail ?? 'no reason was given'}; prepare it again from Organization → Sandboxes`
        );
        this.options.logger.error(
          'the disk image for build {build} could not be prepared from {base}, so no sandbox can be made: {error}',
          {
            component: COMPONENT,
            build: automatic.plan.build,
            base: automatic.plan.base,
            error: status.detail,
          }
        );
        return;
      }
      if (status?.state !== 'ready' || !status.diskImageId) {
        this.noOrchestrator(
          `the disk image for build ${automatic.plan.build} is being prepared from ${automatic.plan.base}; sandboxes are made once it is ready`,
          'starting'
        );
        // Waited on whoever began it — this host, or a Test connection
        // run before the setup was saved — and once: when it ends, the
        // setup is read again and the image it came to is taken up.
        if (this.awaiting !== automatic.key) {
          this.awaiting = automatic.key;
          this.options.logger.info(
            status
              ? 'waiting on the disk image for build {build}, already being prepared from {base}; sandboxes are made once it is ready'
              : 'preparing the disk image for build {build} from {base}; sandboxes are made once it is ready',
            { component: COMPONENT, build: automatic.plan.build, base: automatic.plan.base }
          );
          const key = automatic.key;
          void startDiskImage(row, automatic, image.preparer, this.options.deps, {
            ...(image.pollMs ? { pollMs: image.pollMs } : {}),
          })
            .then(
              (id) =>
                this.options.logger.info(
                  'the disk image for build {build} is ready ({diskImage}); sandboxes are made from it',
                  { component: COMPONENT, build: automatic.plan.build, diskImage: id }
                ),
              () => undefined
            )
            .finally(() => {
              if (this.awaiting === key) this.awaiting = null;
              this.fingerprint = null;
              void this.reload();
            });
        }
        return;
      }
      preparedDiskImage = status.diskImageId;
    }

    const built = await buildFromStored(row, this.options.deps, preparedDiskImage);
    if (typeof built === 'string') {
      this.noOrchestrator(built);
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
    this.problemType = 'provider';
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
