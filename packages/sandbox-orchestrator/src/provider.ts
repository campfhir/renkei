/**
 * What the orchestrator needs of whatever makes sandboxes: a Linux
 * machine of the caller's own, made from the sandbox image, that can be
 * suspended, resumed and removed, and says where its worker answers.
 *
 * Two providers stand behind it: Azure Container Apps sandboxes in
 * production (azure-provider.ts — a microVM per sandbox in a sandbox
 * group) and the Docker engine on a developer's machine or a single host
 * (docker-provider.ts — a container per sandbox), so everything above
 * this interface is exercised locally without an Azure subscription.
 *
 * A provider keeps no state of its own and decides nothing: which scope
 * gets a sandbox, when one is suspended and when it goes are the
 * orchestrator's (orchestrator.ts), recorded in `sandboxes`. Every
 * machine a provider makes carries the sandbox's id as a label, which is
 * how a machine whose row is gone is found and removed.
 */

import type { SandboxKind } from '@renkei/db';

/** The port the sandbox worker listens on inside every sandbox. */
export const SANDBOX_WORKER_PORT = 8092;

export interface SandboxSpec {
  /** The orchestrator's id for the sandbox (the row's); labelled on the machine. */
  sandboxId: string;
  kind: SandboxKind;
  /** The worker's whole environment. */
  env: Record<string, string>;
  /**
   * The orchestrator's own idle rule for suspending, for a provider that
   * can also enforce it itself (Azure's lifecycle policy) as a backstop
   * behind an orchestrator that is down. There is no such backstop for
   * removal: a sandbox is only ever removed by the orchestrator, after
   * what it holds has been archived.
   */
  idleSuspendSeconds: number;
}

/**
 * - `starting`: made or resuming, not yet answering.
 * - `running`: up; `address` is where its worker is.
 * - `stopping`: on its way to suspended.
 * - `suspended`: not running, its disk (and, where the provider can, its
 *   memory) kept; `resume` brings it back.
 * - `failed`: there, but it will not run again; only `destroy` is left.
 */
export type ProviderSandboxState = 'starting' | 'running' | 'stopping' | 'suspended' | 'failed';

export interface ProviderSandbox {
  providerId: string;
  state: ProviderSandboxState;
  /** The worker's base address, no trailing slash; null unless running. */
  address: string | null;
  /** The orchestrator's id, from the machine's label; null when it carries none. */
  sandboxId: string | null;
  createdAt: Date | null;
}

export interface SandboxProvider {
  /** `docker`, `azure`: what `sandboxes.provider` records. */
  readonly name: string;
  /** Whether the provider answers at all: the boot check. Throws with why not. */
  check(): Promise<void>;
  /**
   * Make and start a sandbox. Returns once the provider has a name for
   * it, which may be before it answers; a create that fails half way
   * removes what it made.
   */
  create(spec: SandboxSpec): Promise<{ providerId: string }>;
  /** The sandbox as the provider sees it now; null when it has none by that name. */
  inspect(providerId: string): Promise<ProviderSandbox | null>;
  /** Stop it, keeping its disk. Already suspended is fine. */
  suspend(providerId: string): Promise<void>;
  /** Start a suspended one. Already running is fine. */
  resume(providerId: string): Promise<void>;
  /** Remove it and everything it held. Already gone is fine. */
  destroy(providerId: string): Promise<void>;
  /** Every sandbox this deployment's orchestrator made, whatever its state. */
  list(): Promise<ProviderSandbox[]>;
  /**
   * What a call to a sandbox's worker must carry to get past whatever the
   * provider puts in front of it, besides the worker's own key: on Azure
   * with Entra on the port, `authorization: Bearer <an Entra token>`.
   * Absent or empty where nothing stands in front (Docker).
   */
  callerHeaders?(): Promise<Record<string, string>>;
  /**
   * Open another port of a running sandbox straight to the browsers of
   * the named people, each signing in as themselves (a code project's
   * preview, opened by its members): the address it is served at. People
   * already let in at that port stay let in; `unexposePort` lets nobody.
   * Absent where the provider has no such door — a preview is then
   * reached through the worker's own proxy, as before.
   */
  exposePort?(
    providerId: string,
    port: number,
    access: { emails: string[] }
  ): Promise<{ url: string }>;
  /** Close a port opened with `exposePort`. Already closed is fine. */
  unexposePort?(providerId: string, port: number): Promise<void>;
}

/** A provider's refusal or failure, with the provider's own words. */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** The provider's HTTP status, 0 when it never answered. */
    readonly status: number = 0
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
