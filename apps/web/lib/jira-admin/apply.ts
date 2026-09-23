/**
 * Applying a Jira admin change request, and who may.
 *
 * Only the apply route calls `applyChangeRequest`, and only after
 * `applyGate` agreed and the route won the row's claim. The gate asks the
 * same questions the MCP endpoint asks before it registers a jira_admin_
 * act tool — org read-only mode, the org's off switch, the connector's
 * audience, a connected grant — through the same projection, so turning
 * Jira Administration off (or putting the org in read-only mode) stops
 * pending proposals from being applied, not only new ones from being made.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { ATLASSIAN_ADMIN_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import { resolveAudience } from '@/lib/connectors/audience';
import { buildProjection } from '@/lib/mcp-tools/projection';
import { resolveConnectorAvailability } from '@/lib/mcp-tools/registry';
import { JIRA_ADMIN_MCP_CONNECTOR } from '@/lib/mcp-tools/jira-admin';
import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import type { ChangeRequest, OperationResult } from './change-requests';
import { FIELD_OPTIONS_KIND, applyFieldOptions, readFieldOptionsPayload } from './field-options';
import { CREATE_SPACE_KIND, applySpaceCreation, readCreateSpacePayload } from './space-creation';

/** The classic scopes each kind's writes stand on. */
const SCOPES_BY_KIND: Record<string, string[]> = {
  [FIELD_OPTIONS_KIND]: ['manage:jira-configuration'],
  // Checking the key and reading a role (read:jira-work); creating the
  // space and adding role members (manage:jira-configuration).
  [CREATE_SPACE_KIND]: ['read:jira-work', 'manage:jira-configuration'],
};

type Gate = { ok: true } | { ok: false; reason: string };

export async function applyGate(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  roles: readonly string[],
  kind: string
): Promise<Gate> {
  const settingsResult = await getOrgSettings(tenantId);
  if (!settingsResult.ok)
    return { ok: false, reason: 'Could not read your organization’s settings.' };
  const settings = settingsResult.val;
  if (settings.readOnly) {
    return {
      ok: false,
      reason: 'Your organization is in read-only mode, so admin changes cannot be applied.',
    };
  }
  if (settings.disabledConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR)) {
    return { ok: false, reason: 'Jira Administration is switched off for your organization.' };
  }

  const [availability, audience] = await Promise.all([
    resolveConnectorAvailability(db, tenantId, subject),
    resolveAudience(db, tenantId, subject),
  ]);
  if (
    audience.restrictedConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR) &&
    !audience.allowedConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR)
  ) {
    return {
      ok: false,
      reason:
        'Your organization limits Jira Administration to certain people, and you are not one.',
    };
  }
  if (!availability.jiraAdminAvailable) {
    return {
      ok: false,
      reason: 'Jira Administration is not connected. Connect it on the Connectors page first.',
    };
  }
  const missing = (SCOPES_BY_KIND[kind] ?? ['manage:jira-configuration']).filter(
    (scope) => !availability.jiraAdminScopes.includes(scope)
  );
  if (missing.length > 0) {
    // Name the boxes on the connect picker, which is where it is fixed.
    const boxes = ATLASSIAN_ADMIN_SCOPE_OPTIONS.filter((option) =>
      option.scopes.some((scope) => missing.includes(scope))
    ).map((option) => option.label);
    return {
      ok: false,
      reason:
        `Your Jira Administration connection does not include ${missing.join(', ')}. ` +
        `Reconnect it with ${boxes.join(' and ') || 'the permissions this change needs'} ticked.`,
    };
  }

  // The questions above give a person the reason; the projection is the
  // rule itself, and has the last word should the two ever disagree.
  const projection = buildProjection({ settings, availability, roles, audience });
  if (
    !projection.allows({
      id: 'jira_admin_apply_change',
      connector: JIRA_ADMIN_MCP_CONNECTOR,
      kind: 'act',
    })
  ) {
    return { ok: false, reason: 'Jira Administration changes are not available to you.' };
  }
  return { ok: true };
}

/**
 * May this person see Jira Administration's own records — the org's space
 * templates? The connector's off switch, its audience and a connected grant
 * decide, as they decide whether its tools register. Read-only mode does
 * not: looking changes nothing.
 */
export async function viewGate(db: Kysely<DB>, tenantId: string, subject: string): Promise<Gate> {
  const settingsResult = await getOrgSettings(tenantId);
  if (!settingsResult.ok)
    return { ok: false, reason: 'Could not read your organization’s settings.' };
  if (settingsResult.val.disabledConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR)) {
    return { ok: false, reason: 'Jira Administration is switched off for your organization.' };
  }
  const [availability, audience] = await Promise.all([
    resolveConnectorAvailability(db, tenantId, subject),
    resolveAudience(db, tenantId, subject),
  ]);
  if (
    audience.restrictedConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR) &&
    !audience.allowedConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR)
  ) {
    return {
      ok: false,
      reason:
        'Your organization limits Jira Administration to certain people, and you are not one.',
    };
  }
  if (!availability.jiraAdminAvailable) {
    return {
      ok: false,
      reason: 'Jira Administration is not connected. Connect it on the Connectors page first.',
    };
  }
  return { ok: true };
}

export async function applyChangeRequest(
  scope: { tenantId: string; subject?: string },
  access: JiraAdminAccess,
  change: Pick<ChangeRequest, 'kind' | 'payload'>
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  if (change.kind === FIELD_OPTIONS_KIND) {
    const payload = readFieldOptionsPayload(change.payload);
    if (payload) return applyFieldOptions(scope, access, payload);
  }
  if (change.kind === CREATE_SPACE_KIND) {
    const payload = readCreateSpacePayload(change.payload);
    if (payload) return applySpaceCreation(scope, access, payload);
  }
  return {
    status: 'failed',
    results: [
      {
        label: 'Read the change request',
        outcome: 'failed',
        detail: 'This change request is not in a shape Renkei can apply; nothing was changed.',
      },
    ],
  };
}
