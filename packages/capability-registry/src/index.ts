/**
 * @renkei/capability-registry — what a connector offers, and what one user
 * actually sees (RENKEI.md Decisions #12 and #13).
 *
 * Connectors declare capabilities; what any given user (or an agent acting
 * for them) sees is the declared set filtered through three gates, applied
 * in this order:
 *
 *   1. the org-admin's capability policy — is the capability enabled for the
 *      org at all, and within what constraints;
 *   2. the user's provisioned connectors — an unprovisioned connector
 *      exposes nothing;
 *   3. the user's own expose/hide choices.
 *
 * The MCP tool list and the A2A Agent Card are per-user projections of this
 * filtering, never a global catalog. The projection is pure data-in,
 * data-out: policy comes from org-admin configuration and user preferences,
 * and nothing downstream (a model, an agent, a tool argument) can widen it.
 */

/**
 * How a capability touches the provider. 'read' observes; 'act' mutates.
 * The distinction is what org-wide read-only mode filters on.
 */
export type CapabilityKind = 'read' | 'act';

export interface CapabilityDescriptor {
  /** Stable identifier; for MCP tools this is the tool name. */
  id: string;
  /** The connector that registered it ('jira', 'webex', …). */
  connector: string;
  kind: CapabilityKind;
}

/** Gate 1 — the org-admin's envelope. */
export interface OrgCapabilityPolicy {
  /** Org-wide read-only mode: no 'act' capability is exposed to anyone. */
  readOnly: boolean;
  /** Connectors switched off org-wide. */
  disabledConnectors: readonly string[];
  /** Individual capabilities switched off org-wide. */
  disabledCapabilities: readonly string[];
}

/** Gates 2 and 3 — the user's provisioning and their own expose/hide choices. */
export interface UserCapabilitySelection {
  /** Connectors this user has linked an account for. */
  provisionedConnectors: readonly string[];
  /** Capabilities this user chose not to surface to models and agents. */
  hiddenCapabilities: readonly string[];
}

/** An org policy with everything enabled — the single-org deployment default. */
export const OPEN_ORG_POLICY: OrgCapabilityPolicy = {
  readOnly: false,
  disabledConnectors: [],
  disabledCapabilities: [],
};

export interface CapabilityProjection {
  allows(capability: CapabilityDescriptor): boolean;
}

/**
 * Build the per-user projection. The three gates compose by AND — each can
 * only narrow, never widen, what an earlier gate allowed.
 */
export function createProjection(
  org: OrgCapabilityPolicy,
  user: UserCapabilitySelection
): CapabilityProjection {
  const disabledConnectors = new Set(org.disabledConnectors);
  const disabledCapabilities = new Set(org.disabledCapabilities);
  const provisioned = new Set(user.provisionedConnectors);
  const hidden = new Set(user.hiddenCapabilities);

  return {
    allows(capability: CapabilityDescriptor): boolean {
      if (org.readOnly && capability.kind === 'act') return false;
      if (disabledConnectors.has(capability.connector)) return false;
      if (disabledCapabilities.has(capability.id)) return false;
      if (!provisioned.has(capability.connector)) return false;
      if (hidden.has(capability.id)) return false;
      return true;
    },
  };
}

/** Project a declared capability set for one user. */
export function projectCapabilities(
  declared: readonly CapabilityDescriptor[],
  org: OrgCapabilityPolicy,
  user: UserCapabilitySelection
): CapabilityDescriptor[] {
  const projection = createProjection(org, user);
  return declared.filter((capability) => projection.allows(capability));
}
