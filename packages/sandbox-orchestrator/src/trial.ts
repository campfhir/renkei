/**
 * A test sandbox: what Test connection on Organization → Sandboxes does
 * after the provider answers. It makes one real sandbox from the setup
 * being tried, the way the orchestrator makes every sandbox — the same
 * image, size, port and environment (`sandboxWorkerEnv`) — and waits for
 * its worker to come up the way a real one does: it asks this
 * orchestrator for its sealed environment at the callback address, then
 * answers `/health` through whatever the provider puts in front of it.
 * Then it is removed, whatever happened.
 *
 * So a passing test says what a first real call needs: the image is the
 * sandbox image and boots, the sandbox reaches the orchestrator at the
 * address the setup gives it, its sealed boot opens what it is handed,
 * and the orchestrator can call its worker. A failing one says which of
 * those did not happen.
 *
 * A test sandbox has no row in `sandboxes`: it is known only to the
 * `TrialSandboxes` registry of the process running the test, which is
 * what lets its worker's bootstrap and data store calls in (with no one
 * to serve, as a sandbox just made has). If the process dies mid-test,
 * the sweep removes the machine as one without a record, after its grace.
 */

import { timingSafeEqual } from 'node:crypto';
import { sealSandboxEnv } from '@renkei/connector-sandbox';
import type { SandboxKind } from '@renkei/db';
import { sandboxApiKey } from './keys';
import {
  SANDBOX_WORKER_PORT,
  withoutTrailingSlashes,
  type ProviderSandboxState,
  type SandboxProvider,
} from './provider';

/**
 * What a sandbox is created with: its own key, its id and where the
 * orchestrator is — nothing else; the rest it asks for, sealed.
 */
export function sandboxWorkerEnv(
  masterKey: string,
  sandboxId: string,
  callbackUrl: string | null | undefined
): Record<string, string> {
  return {
    SANDBOX_WORKER_API_KEY: sandboxApiKey(masterKey, sandboxId),
    SANDBOX_WORKER_PORT: String(SANDBOX_WORKER_PORT),
    SANDBOX_ORCHESTRATED: '1',
    SANDBOX_INSTANCE_ID: sandboxId,
    ...(callbackUrl
      ? { SANDBOX_ORCHESTRATOR_CALLBACK_URL: withoutTrailingSlashes(callbackUrl) }
      : {}),
  };
}

interface Trial {
  kind: SandboxKind;
  env: Record<string, string>;
  bootstrapped: boolean;
}

/** The test sandboxes this process has made and not yet removed. */
export class TrialSandboxes {
  private readonly trials = new Map<string, Trial>();

  constructor(private readonly masterKey: string) {}

  /** Know a test sandbox by its id until `done` is called. */
  register(
    sandboxId: string,
    env: Record<string, string>
  ): { bootstrapped: () => boolean; done: () => void } {
    const trial: Trial = { kind: 'system', env, bootstrapped: false };
    this.trials.set(sandboxId, trial);
    return {
      bootstrapped: () => trial.bootstrapped,
      done: () => {
        this.trials.delete(sandboxId);
      },
    };
  }

  /** The test sandbox calling, when `presentedKey` is its own; null otherwise. */
  authenticate(sandboxId: string, presentedKey: string): { id: string; kind: SandboxKind } | null {
    const trial = this.trials.get(sandboxId);
    if (!trial) return null;
    const expected = Buffer.from(sandboxApiKey(this.masterKey, sandboxId));
    const presented = Buffer.from(presentedKey);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    return { id: sandboxId, kind: trial.kind };
  }

  /** What the test sandbox's worker is started with, sealed for it alone; null for one unknown. */
  sealedEnvironment(sandboxId: string): string | null {
    const trial = this.trials.get(sandboxId);
    if (!trial) return null;
    trial.bootstrapped = true;
    return sealSandboxEnv(sandboxApiKey(this.masterKey, sandboxId), sandboxId, trial.env);
  }
}

/** What the worker's `/health` answered: its status, or 0 when nothing answered. */
export type TrialProbe = (
  address: string,
  headers: Record<string, string>
) => Promise<{ status: number }>;

async function defaultProbe(
  address: string,
  headers: Record<string, string>
): Promise<{ status: number }> {
  try {
    const response = await fetch(`${address}/health`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  } catch {
    return { status: 0 };
  }
}

export interface TrySandboxOptions {
  provider: SandboxProvider;
  trials: TrialSandboxes;
  masterKey: string;
  /** Where the sandbox reaches this orchestrator: the setup's callback address. */
  callbackUrl: string;
  /** What every sandbox's worker is handed, sealed. */
  env: Record<string, string>;
  /** What the sandbox is made from, in words: `the disk image "…"`. */
  source: string;
  newId: () => string;
  /** How long the sandbox gets to come up and answer. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: TrialProbe;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make a test sandbox from the setup, wait for its worker to answer,
 * remove it. A failed try is an answer, in a sentence that says how far
 * it got.
 */
export async function trySandbox(
  options: TrySandboxOptions
): Promise<{ ok: boolean; detail: string }> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callbackUrl = withoutTrailingSlashes(options.callbackUrl);
  const sandboxId = options.newId();
  const trial = options.trials.register(sandboxId, options.env);
  const started = now();
  const seconds = (): number => Math.round((now() - started) / 1000);
  let providerId: string | null = null;

  const outcome = await (async (): Promise<{ ok: boolean; detail: string }> => {
    try {
      ({ providerId } = await options.provider.create({
        sandboxId,
        kind: 'system',
        env: sandboxWorkerEnv(options.masterKey, sandboxId, callbackUrl),
        idleSuspendSeconds: Math.round(timeoutMs / 1000),
      }));
    } catch (error) {
      return {
        ok: false,
        detail: `Could not make a test sandbox from ${options.source}: ${messageOf(error)}`,
      };
    }

    let state: ProviderSandboxState | 'gone';
    let address: string | null;
    let lastStatus = 0;
    for (;;) {
      try {
        const seen = await options.provider.inspect(providerId);
        state = seen ? seen.state : 'gone';
        address = seen?.address ?? null;
      } catch (error) {
        return {
          ok: false,
          detail: `Made a test sandbox from ${options.source}, but could not ask the provider about it: ${messageOf(error)}`,
        };
      }
      if (state === 'gone' || state === 'failed' || state === 'suspended') {
        return {
          ok: false,
          detail: `Made a test sandbox from ${options.source}, but it ${
            state === 'gone' ? 'disappeared' : state === 'failed' ? 'failed' : 'stopped'
          } before its worker answered.`,
        };
      }
      if (state === 'running' && address) {
        let headers: Record<string, string>;
        try {
          headers = (await options.provider.callerHeaders?.()) ?? {};
        } catch (error) {
          return {
            ok: false,
            detail: `The test sandbox from ${options.source} is running, but no credential could be got for calling it: ${messageOf(error)}`,
          };
        }
        lastStatus = (await probe(address, headers)).status;
        if (lastStatus >= 200 && lastStatus < 300) {
          return {
            ok: true,
            detail: `Made a test sandbox from ${options.source}: it fetched its sealed environment from ${callbackUrl} and its worker answered at ${address} after ${seconds()} s. It has been removed.`,
          };
        }
      }
      if (now() - started > timeoutMs) break;
      await sleep(POLL_MS);
    }

    const waited = `${Math.round(timeoutMs / 1000)} s`;
    if (state !== 'running' || !address) {
      return {
        ok: false,
        detail: `Made a test sandbox from ${options.source}, but it was still ${state} after ${waited}.`,
      };
    }
    if (!trial.bootstrapped()) {
      return {
        ok: false,
        detail: `The test sandbox from ${options.source} is running, but in ${waited} its worker never asked for its environment at ${callbackUrl}/sandbox/v1/bootstrap. Check that the sandbox can reach that address (the orchestrator address on this page) and that the image is the renkei sandbox image.`,
      };
    }
    if (lastStatus === 401 || lastStatus === 403) {
      return {
        ok: false,
        detail: `The test sandbox from ${options.source} fetched its environment, but its worker port refused the orchestrator (HTTP ${lastStatus}). With Microsoft Entra on the worker port, the orchestrator's identity must be allowed; or switch the worker port to Sandbox key only.`,
      };
    }
    return {
      ok: false,
      detail: `The test sandbox from ${options.source} fetched its environment, but its worker did not answer at ${address}/health in ${waited}${
        lastStatus ? ` (last answer HTTP ${lastStatus})` : ''
      }. The sandbox's own log says why it did not start.`,
    };
  })();

  trial.done();
  if (providerId) {
    try {
      await options.provider.destroy(providerId);
    } catch (error) {
      return {
        ok: outcome.ok,
        detail: `${outcome.detail} Removing the test sandbox (${providerId}) failed: ${messageOf(error)}; remove it by hand.`,
      };
    }
  }
  return outcome;
}
