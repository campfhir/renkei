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

import { getOrgSettings } from '@renkei/settings';
import { ATLASSIAN_ADMIN_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import { resolveAudience } from '@/lib/connectors/audience';
import { buildProjection } from '@/lib/mcp-tools/projection';
import { resolveConnectorAvailability } from '@/lib/mcp-tools/registry';
import { JIRA_ADMIN_MCP_CONNECTOR } from '@/lib/mcp-tools/jira-admin';
import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import type { ChangeRequest, OperationResult } from './change-requests';
import { FIELD_OPTIONS_KIND, applyFieldOptions, readFieldOptionsPayload } from './field-options';
import {
  CREATE_SPACE_KIND,
  applySpaceCreation,
  createSpaceScopes,
  readCreateSpacePayload,
} from './space-creation';
import { SPACE_FIELD_KIND, applySpaceField, readSpaceFieldPayload } from './space-field';
import { WORK_TYPE_KIND, applyWorkType, readWorkTypePayload } from './work-type';
import {
  SCREEN_CHANGES_KIND,
  applyScreenChanges,
  readScreenChangesPayload,
} from './screen-changes';
import { REQUEST_TYPE_KIND, applyRequestType, readRequestTypePayload } from './request-type';
import {
  holdsRequestTypeScopes,
  jsmGrantScopes,
  missingRequestTypeScopes,
} from '@/lib/mcp-tools/jira-admin/jsm-access';
import {
  AUTOMATION_RULE_KIND,
  AUTOMATION_RUN_KIND,
  AUTOMATION_STATE_KIND,
  applyAutomationRule,
  applyAutomationRun,
  applyAutomationState,
  isAutomationKind,
  readAutomationRulePayload,
  readAutomationRunPayload,
  readAutomationStatePayload,
} from './automation';
import {
  NO_TOKEN,
  hasAutomationToken,
  issueAri,
} from '@/lib/mcp-tools/jira-admin/automation-client';

/**
 * The classic scopes applying a change stands on. Option writes are
 * manage:jira-configuration. A new space: checking the key and reading a
 * role (read:jira-work), creating it and adding role members
 * (manage:jira-configuration), and — only when it has any — components and
 * versions (manage:jira-project). A field for a space takes all three: the
 * field search (read:jira-work), the field, its contexts and options
 * (manage:jira-configuration) and screen tabs (manage:jira-project), so it
 * falls to the default. A work type, a screen and a request type each name
 * their own below. Anything unrecognised asks for the most.
 */
export function changeScopes(change: Pick<ChangeRequest, 'kind' | 'payload'>): string[] {
  if (change.kind === FIELD_OPTIONS_KIND) return ['manage:jira-configuration'];
  if (change.kind === CREATE_SPACE_KIND) {
    const payload = readCreateSpacePayload(change.payload);
    if (payload) return createSpaceScopes(payload);
  }
  // A work type: the site's work types (read:jira-work), then creating it,
  // its icon and its scheme mappings (manage:jira-configuration).
  if (change.kind === WORK_TYPE_KIND) return ['read:jira-work', 'manage:jira-configuration'];
  // A screen's tabs and fields, read and changed (manage:jira-project).
  if (change.kind === SCREEN_CHANGES_KIND) return ['manage:jira-project'];
  // A request type writes nothing on this grant — the JSM grant's scopes are
  // the gate's second question — but the connector must be connected.
  if (change.kind === REQUEST_TYPE_KIND) return ['read:jira-work'];
  // Automation runs on the API token; this grant only has to be connected.
  if (isAutomationKind(change.kind)) return ['read:jira-work'];
  return ['read:jira-work', 'manage:jira-configuration', 'manage:jira-project'];
}

type Gate = { ok: true } | { ok: false; reason: string };

export async function applyGate(
  subject: string,
  roles: readonly string[],
  change: Pick<ChangeRequest, 'kind' | 'payload'>
): Promise<Gate> {
  const settingsResult = await getOrgSettings();
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
    resolveConnectorAvailability(subject),
    resolveAudience(subject),
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
  const missing = changeScopes(change).filter(
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
        `Reconnect it with ${boxes.join(' and ') || 'the permissions this change needs'} ticked ` +
        '(if it is not offered, an organization admin allows it under Connector setup first).',
    };
  }

  if (change.kind === REQUEST_TYPE_KIND) {
    // The one kind that writes on another grant: the JSM grant, with the
    // picker's "Set up request types" box.
    const jsmScopes = await jsmGrantScopes(subject);
    if (jsmScopes === null) {
      return {
        ok: false,
        reason:
          'Jira Service Management is not connected. Request types are created on that ' +
          'connection; connect it on the Connectors page with “Set up request types” ticked.',
      };
    }
    if (!holdsRequestTypeScopes(jsmScopes)) {
      return {
        ok: false,
        reason:
          'Your Jira Service Management connection does not include ' +
          `${missingRequestTypeScopes(jsmScopes).join(', ')}. Reconnect it with “Set up request ` +
          'types” ticked (if it is not offered, an organization admin allows it under Connector ' +
          'setup first).',
      };
    }
  }

  if (isAutomationKind(change.kind)) {
    // The kinds that run on the person's own Atlassian API token.
    if (!(await hasAutomationToken(subject))) return { ok: false, reason: NO_TOKEN };
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
export async function viewGate(subject: string): Promise<Gate> {
  const settingsResult = await getOrgSettings();
  if (!settingsResult.ok)
    return { ok: false, reason: 'Could not read your organization’s settings.' };
  if (settingsResult.val.disabledConnectors.includes(JIRA_ADMIN_MCP_CONNECTOR)) {
    return { ok: false, reason: 'Jira Administration is switched off for your organization.' };
  }
  const [availability, audience] = await Promise.all([
    resolveConnectorAvailability(subject),
    resolveAudience(subject),
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
  scope: { subject?: string },
  access: JiraAdminAccess,
  change: Pick<ChangeRequest, 'kind' | 'payload'>,
  /** The JSM grant (a request type) or the API token (automation), which run instead of `access`. */
  grants: { jsm?: JiraAdminAccess; automation?: JiraAdminAccess } = {}
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  if (change.kind === FIELD_OPTIONS_KIND) {
    const payload = readFieldOptionsPayload(change.payload);
    if (payload) return applyFieldOptions(scope, access, payload);
  }
  if (change.kind === CREATE_SPACE_KIND) {
    const payload = readCreateSpacePayload(change.payload);
    if (payload) return applySpaceCreation(scope, access, payload);
  }
  if (change.kind === SPACE_FIELD_KIND) {
    const payload = readSpaceFieldPayload(change.payload);
    if (payload) return applySpaceField(scope, access, payload);
  }
  if (change.kind === WORK_TYPE_KIND) {
    const payload = readWorkTypePayload(change.payload);
    if (payload) return applyWorkType(scope, access, payload);
  }
  if (change.kind === SCREEN_CHANGES_KIND) {
    const payload = readScreenChangesPayload(change.payload);
    if (payload) return applyScreenChanges(scope, access, payload);
  }
  if (change.kind === REQUEST_TYPE_KIND) {
    const payload = readRequestTypePayload(change.payload);
    if (payload && !grants.jsm) {
      return {
        status: 'failed',
        results: [
          {
            label: 'Reach Jira Service Management',
            outcome: 'failed',
            detail: 'The Jira Service Management connection was not resolved; nothing was changed.',
          },
        ],
      };
    }
    if (payload && grants.jsm) return applyRequestType(scope, grants.jsm, payload);
  }
  if (isAutomationKind(change.kind)) {
    const automation = grants.automation;
    if (!automation) {
      return {
        status: 'failed',
        results: [
          {
            label: 'Reach the Automation API',
            outcome: 'failed',
            detail: 'The Atlassian API token was not resolved; nothing was changed.',
          },
        ],
      };
    }
    if (change.kind === AUTOMATION_STATE_KIND) {
      const payload = readAutomationStatePayload(change.payload);
      if (payload) return applyAutomationState(scope, automation, payload);
    }
    if (change.kind === AUTOMATION_RULE_KIND) {
      const payload = readAutomationRulePayload(change.payload);
      if (payload) return applyAutomationRule(scope, automation, payload);
    }
    if (change.kind === AUTOMATION_RUN_KIND) {
      const payload = readAutomationRunPayload(change.payload);
      if (payload) {
        return applyAutomationRun(scope, automation, payload, (id) =>
          issueAri(automation.cloudId, id)
        );
      }
    }
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
