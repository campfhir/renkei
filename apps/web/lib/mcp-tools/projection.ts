/**
 * The per-caller capability projection, built one way.
 *
 * Two places build it — the MCP endpoint and the tool catalog that feeds
 * the tools page, the chat and the agent builder — and they used to build
 * it separately, which is how the catalog came to omit roles while the
 * endpoint honoured them. One constructor, so the list a person is shown
 * and the list their client is served cannot drift again.
 */

import { createProjection, type CapabilityProjection } from '@renkei/capability-registry';
import type { OrgSettings } from '@renkei/settings';
import type { AudienceResolution } from '@/lib/connectors/audience';
import { provisionedConnectorsFor, type ConnectorAvailability } from './registry';

export function buildProjection(input: {
  settings: Pick<OrgSettings, 'readOnly' | 'disabledConnectors'>;
  availability: ConnectorAvailability;
  /** The caller's renkei roles; empty when unknown, which hides role-gated tools. */
  roles: readonly string[];
  audience: AudienceResolution;
}): CapabilityProjection {
  return createProjection(
    {
      readOnly: input.settings.readOnly,
      // The org-admin's org-wide off switch (Connector setup). Unlike
      // narrowing the scope ceiling, this touches no grant, so flipping it
      // back restores the tools without anyone reconnecting.
      disabledConnectors: input.settings.disabledConnectors,
      disabledCapabilities: [],
      // Connectors scoped to an audience; the caller's share is resolved
      // from their recorded identity, never their token.
      restrictedConnectors: input.audience.restrictedConnectors,
    },
    {
      provisionedConnectors: provisionedConnectorsFor(input.availability),
      // Per-capability user expose/hide choices arrive with the preferences UI.
      hiddenCapabilities: [],
      roles: input.roles,
      allowedConnectors: input.audience.allowedConnectors,
    }
  );
}
