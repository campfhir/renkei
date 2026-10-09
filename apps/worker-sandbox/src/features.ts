/**
 * Which of this worker's features an organization gets, decided per
 * request rather than per process.
 *
 * Two things have to hold for a verb to be served. The worker must be
 * ABLE: a Chromium for the browser, a Mermaid bundle for charts, a way to
 * drop commands to a caller's uid for workspaces and scripts, a Docker
 * engine for services, an interpreter and (ideally) network isolation for
 * scripts. Those are found once at boot (index.ts) and reported on
 * `/health` as `SandboxCapabilities`. And the organization must have
 * turned the feature ON: the sandbox switches in its settings (packages/
 * settings, admin → Settings → Sandbox), read here for each request's
 * tenant. The SANDBOX_*_ENABLED environment variables that used to be the
 * only switch — set on two containers, restarted to change — are gone
 * (migration 152 carried their values into each organization's settings).
 *
 * A settings read that fails opens nothing: closed, never open.
 */

import { getOrgSettings } from '@renkei/settings';
import type { NetworkIsolation } from './workspaces';

export interface SandboxCapabilities {
  /** A browser can be launched (always, in practice: it is lazy). */
  browser: boolean;
  /** The Mermaid bundle is present. */
  charts: boolean;
  /** Commands can be run for a caller: not root, or root that can drop to a uid. */
  workspaces: boolean;
  /** A Docker engine answered at boot. */
  services: boolean;
  /**
   * `isolated`: an interpreter and a way to start a run with no network.
   * `network_only`: an interpreter, but every run would have this
   * container's network — served only to an organization that accepted
   * that. `none`: no usable interpreter.
   */
  scripts: 'isolated' | 'network_only' | 'none';
  /** How a caller's commands are separated from each other and from this process. */
  uidIsolation: 'per_caller' | 'unisolated';
  /** Why a capability is missing, by name, for /health readers and the boot log. */
  problems: Partial<Record<'workspaces' | 'services' | 'scripts' | 'charts', string>>;
}

/** The organization's switches, as the handlers consume them. */
export interface OrgSandboxFeatures {
  browser: boolean;
  charts: boolean;
  workspaces: boolean;
  services: boolean;
  scripts: boolean;
  scriptsAllowNetwork: boolean;
}

export type OrgFeaturesLookup = (tenantId: string) => Promise<OrgSandboxFeatures>;

export const NO_ORG_FEATURES: OrgSandboxFeatures = {
  browser: false,
  charts: false,
  workspaces: false,
  services: false,
  scripts: false,
  scriptsAllowNetwork: false,
};

export const ALL_ORG_FEATURES: OrgSandboxFeatures = {
  browser: true,
  charts: true,
  workspaces: true,
  services: true,
  scripts: true,
  scriptsAllowNetwork: true,
};

/** The organization's sandbox switches from its settings; everything off when they cannot be read. */
export async function orgSandboxFeatures(tenantId: string): Promise<OrgSandboxFeatures> {
  const settings = await getOrgSettings(tenantId);
  if (!settings.ok) return NO_ORG_FEATURES;
  const org = settings.val;
  return {
    browser: org.sandboxBrowserEnabled,
    charts: org.sandboxChartsEnabled,
    workspaces: org.sandboxWorkspacesEnabled,
    // Services run beside a checkout; without workspaces there is none.
    services: org.sandboxWorkspacesEnabled && org.sandboxServicesEnabled,
    scripts: org.sandboxScriptsEnabled,
    scriptsAllowNetwork: org.sandboxScriptsAllowNetwork,
  };
}

/**
 * How a scripts request is answered for one organization: the boot-time
 * capability and the org's two switches, as a table. Closed by default —
 * a tool whose description promises "no network" must not quietly run
 * with one; the org's opt-in keeps the degraded behaviour for an admin
 * who has weighed it, and then nothing promises otherwise.
 */
export function decideScriptsFor(
  capability: SandboxCapabilities['scripts'],
  networkIsolation: NetworkIsolation | null,
  org: Pick<OrgSandboxFeatures, 'scripts' | 'scriptsAllowNetwork'>
): { serve: true; networkShared: boolean } | { serve: false; message: string } {
  if (!org.scripts) {
    return { serve: false, message: 'Scripts are not enabled for this organization.' };
  }
  if (capability === 'none') {
    return {
      serve: false,
      message:
        'Scripts are unavailable on this deployment: the sandbox worker has no Python interpreter.',
    };
  }
  if (networkIsolation !== null) return { serve: true, networkShared: false };
  if (org.scriptsAllowNetwork) return { serve: true, networkShared: true };
  return {
    serve: false,
    message:
      'Scripts are unavailable on this deployment: the sandbox worker cannot start a script without network access, and this organization has not allowed scripts to run with it.',
  };
}
