/**
 * The disk image Azure sandboxes boot from, made to match the
 * orchestrator's own build.
 *
 * A sandbox's worker and the orchestrator speak a protocol of their own
 * (its sealed boot, the data store calls it makes through the
 * orchestrator), so a sandbox must run the same build as the orchestrator
 * that made it: an older image half works and then fails in ways that say
 * nothing about why. An Azure sandbox boots only from a disk image in its
 * sandbox group, which the platform builds by pulling a container image —
 * so the orchestrator asks the group for one built from
 * `<image repository>:<its own commit>`, named for that build, and makes
 * sandboxes only once it is Ready.
 *
 * `ensureDiskImage` is the one way that happens: on the orchestrator's
 * start, when the organization's setup is saved or changed, and when an
 * operator asks for it again from Organization → Sandboxes. A Ready image
 * for the build is reused (a restart imports nothing); one still building
 * is waited for; otherwise one is created and waited for. A failed build
 * is never stood in for by an older image.
 */

/** A disk image as the group lists it — only what is read here. */
export interface DiskImageView {
  id: string;
  /** The `name` label the image was created with, when it has one. */
  name: string | null;
  /** The container image it was built from. */
  base: string | null;
  /** The platform's word: Ready (or Succeeded), Failed, or one of its in-between states. */
  state: string;
  message: string | null;
}

/** The part of a sandbox group's disk images this module uses. */
export interface DiskImageClient {
  list(): Promise<DiskImageView[]>;
  get(id: string): Promise<DiskImageView | null>;
  /** Start building one from `base`, labelled `name`; its id, once the group has one. */
  create(base: string, name: string): Promise<string>;
}

/** What the group should hold for this build. */
export interface DiskImagePlan {
  /** The container image to build it from, e.g. `docker.io/acme/renkei-sandbox:<sha>`. */
  base: string;
  /** The label it is known by. */
  name: string;
  /** The orchestrator's commit, for what is said about it. */
  build: string;
}

/**
 * The image this build's sandboxes boot from: the repository's image
 * tagged with the full commit, as CI publishes it, under a name of the
 * build's own.
 */
export function diskImagePlanFor(repository: string, commit: string): DiskImagePlan {
  return {
    base: `${repository}:${commit}`,
    name: `renkei-sandbox-${commit.slice(0, 12)}`,
    build: commit.slice(0, 7),
  };
}

function isReady(state: string): boolean {
  const word = state.toLowerCase();
  return word === 'ready' || word === 'succeeded';
}

function isFailed(state: string): boolean {
  return state.toLowerCase() === 'failed';
}

export interface EnsureDiskImageOptions {
  client: DiskImageClient;
  plan: DiskImagePlan;
  /** Told each state the image passes through, for what the page and /health say. */
  onProgress?: (progress: { id: string | null; state: string }) => void;
  /** How long a build may take before this gives up on it. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 5_000;

/**
 * The id of a Ready disk image built from `plan.base`: one already in the
 * group, one still building waited for, or one made now. Throws, with the
 * platform's own words where it gave some, when none can be had.
 */
export async function ensureDiskImage(options: EnsureDiskImageOptions): Promise<string> {
  const { client, plan } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const mine = (await client.list()).filter(
    (image) => image.name === plan.name && (image.base === null || image.base === plan.base)
  );
  const ready = mine.find((image) => isReady(image.state));
  if (ready) {
    options.onProgress?.({ id: ready.id, state: ready.state });
    return ready.id;
  }
  // One still building (another start of this orchestrator began it) is
  // waited for; a failed one is left where it is, and a new one made.
  let id = mine.find((image) => !isFailed(image.state))?.id ?? null;
  if (!id) {
    options.onProgress?.({ id: null, state: 'Creating' });
    id = await client.create(plan.base, plan.name);
  }

  const started = now();
  for (;;) {
    const image = await client.get(id);
    if (!image) {
      throw new Error(
        `the disk image ${id} for build ${plan.build} disappeared while it was built`
      );
    }
    options.onProgress?.({ id, state: image.state });
    if (isReady(image.state)) return id;
    if (isFailed(image.state)) {
      throw new Error(
        `the disk image for build ${plan.build} could not be built from ${plan.base}${
          image.message ? `: ${image.message}` : ''
        }`
      );
    }
    if (now() - started > timeoutMs) {
      throw new Error(
        `the disk image for build ${plan.build} was still ${image.state} after ${Math.round(
          timeoutMs / 60_000
        )} minutes`
      );
    }
    await sleep(pollMs);
  }
}

/** Where one disk image's preparation is, for /health and the Sandboxes page. */
export interface DiskImageStatus {
  build: string;
  base: string;
  state: 'preparing' | 'ready' | 'failed';
  /** The group's id for it, once it has one. */
  diskImageId: string | null;
  /** The platform's word while preparing; why, when failed. */
  detail: string | null;
}

interface Run {
  promise: Promise<string>;
  status: DiskImageStatus;
}

/**
 * Preparations, one per sandbox group and build: a second ask while one
 * runs joins it, a finished one is answered at once, and a failed one is
 * tried again only when asked to be (`again`). Shared by the orchestrator's
 * own setup and Test connection, so a test of the stored group waits on
 * the same import rather than starting another.
 */
export class DiskImagePreparer {
  private readonly runs = new Map<string, Run>();

  /** The image for `key` (a sandbox group and a build), prepared once. */
  prepare(
    key: string,
    plan: DiskImagePlan,
    run: (onProgress: EnsureDiskImageOptions['onProgress']) => Promise<string>,
    options: { again?: boolean } = {}
  ): Promise<string> {
    const existing = this.runs.get(key);
    if (existing && !(options.again && existing.status.state === 'failed')) {
      return existing.promise;
    }
    const status: DiskImageStatus = {
      build: plan.build,
      base: plan.base,
      state: 'preparing',
      diskImageId: null,
      detail: null,
    };
    const promise = run(({ id, state }) => {
      if (status.state !== 'preparing') return;
      status.diskImageId = id;
      status.detail = state;
    }).then(
      (id) => {
        status.state = 'ready';
        status.diskImageId = id;
        status.detail = null;
        return id;
      },
      (error: unknown) => {
        status.state = 'failed';
        status.detail = error instanceof Error ? error.message : String(error);
        throw error;
      }
    );
    // A failure is read from the status and from whoever awaits it, never left unhandled.
    promise.catch(() => undefined);
    this.runs.set(key, { promise, status });
    return promise;
  }

  /** Where the preparation for `key` is; null when none was asked for. */
  status(key: string): DiskImageStatus | null {
    const run = this.runs.get(key);
    return run ? { ...run.status } : null;
  }
}
