/**
 * Whether a staged action batch needs a PERSON to accept it.
 *
 * An agent never calls a tool that changes something: it stages the calls
 * (action-batch.ts) and a separate executor runs them once the batch is
 * accepted. Acceptance is a person clicking Accept on the batch's card —
 * or, for an agent whose owner turned on "accept proposed actions
 * automatically", the engine accepting on their behalf. Auto-accept is
 * honored only where the org lets it be (`agentActStepsRequireApproval`,
 * @renkei/settings), because an agent run acts on content it did not
 * write — a mail that arrived, a chat message, an API caller's payload:
 *
 *   - 'externally_triggered' (default): a run an event or a webhook started
 *     always waits for a person; a run a person started by hand, or a
 *     schedule, honors auto-accept.
 *   - 'all': every batch waits for a person.
 *   - 'off': auto-accept is always honored.
 *
 * Beneath the setting sits a fixed list of tools whose effect is hard to
 * take back or reaches other people — sending mail, merging a pull request,
 * deleting or sharing a document, directory writes — and a batch holding
 * one waits for a person under every setting. The list names registered
 * tool names and nothing else (apps/web's high-risk-tools test holds it to
 * the catalog).
 *
 * Shared between the engine (which decides when a batch is staged) and the
 * web app (which tells owners what auto-accept will and will not cover),
 * so both answer from the same words.
 */

import type { ActApprovalPolicy } from '@renkei/settings';

/**
 * Tools a person must ALWAYS accept, whatever the org's policy or the
 * agent's auto-accept says. Preview (`*_preview`) tools stand in for the
 * directory writes that have no plain Act tool. `*_confirm` tools are not
 * here: they are app-only and never offered to a run at all.
 */
export const ALWAYS_APPROVAL_TOOLS: readonly string[] = [
  // Mail leaves the org under the owner's name.
  'outlook_send_mail',
  'outlook_reply_message',
  'outlook_reply_all_message',
  'outlook_forward_message',
  'outlook_start_bulk_mail_job',
  // Messages to other people.
  'webex_send_message',
  'teams_send_chat_message',
  'teams_send_channel_message',
  // Code that ships.
  'bitbucket_merge_pull_request',
  'github_merge_pull_request',
  // Repository access for other people.
  'bitbucket_grant_repository_permission',
  'github_grant_repository_permission',
  // Documents destroyed or opened to others.
  'onedrive_delete_document',
  'onedrive_share_document',
  'onedrive_add_user_to_document',
  'sharepoint_delete_document',
  'sharepoint_delete_page',
  'sharepoint_share_document',
  'sharepoint_add_user_to_document',
  // Notes destroyed.
  'onenote_delete_page',
  // Work items destroyed.
  'jira_delete_issue',
  // CRM records destroyed, changed in bulk, or handed to someone else.
  'salesforce_delete_records_preview',
  'salesforce_update_records_preview',
  'salesforce_change_owner_preview',
  // An integration engine's traffic and configuration.
  'mirth_send_message',
  'mirth_control_channels',
  'mirth_control_connector',
  'mirth_deploy_channels',
  'mirth_undeploy_channels',
  'mirth_import_channel',
  'mirth_reprocess_messages',
  'mirth_set_channel_enabled',
  'mirth_set_global_scripts',
  'mirth_set_configuration_map',
  // Directory writes: a person's credential, an application's identity
  // and who may use it.
  'admanager_reset_password_preview',
  'entra_add_api_permissions_preview',
  'entra_add_api_scope_preview',
  'entra_add_app_roles_preview',
  'entra_assign_app_role_preview',
  'entra_create_application_preview',
  'entra_create_enterprise_application_preview',
  'entra_remove_api_permissions_preview',
  'entra_remove_api_scope_preview',
  'entra_remove_app_role_assignment_preview',
  'entra_remove_app_role_preview',
  'entra_update_application_preview',
];

const ALWAYS = new Set(ALWAYS_APPROVAL_TOOLS);

export function isAlwaysApprovalTool(tool: string): boolean {
  return ALWAYS.has(tool);
}

/**
 * Whether a run's start counts as external for the policy: an event
 * trigger ('event' — a connector's fan-out) or an API-key invocation
 * ('api' — a webhook from another system). 'manual' (a person pressed
 * Run) and 'schedule' are the org's own clock and hand. 'agent' — a run
 * another run chained — is resolved by the engine to the ROOT of its
 * chain before it gets here; one that could not be resolved reads as
 * external, the fail-closed direction.
 */
export function isExternallyTriggered(triggerKind: string): boolean {
  return triggerKind !== 'manual' && triggerKind !== 'schedule';
}

export type ToolKindHint = 'read' | 'act' | null;

/** Why a batch waits for a person: the owner reviews, a tool is on the fixed list, or the org's policy applies. */
export type ActApprovalReason = 'owner' | 'high-risk' | 'policy';

export interface ActApprovalInput {
  /** Every tool the batch would call. */
  tools: readonly string[];
  /** The agent's own "accept proposed actions automatically". */
  autoAccept: boolean;
  policy: ActApprovalPolicy;
  externallyTriggered: boolean;
}

/** Null when the batch may be accepted without a person; otherwise why it waits. */
export function actApprovalReason(input: ActApprovalInput): ActApprovalReason | null {
  if (input.tools.some(isAlwaysApprovalTool)) return 'high-risk';
  if (!input.autoAccept) return 'owner';
  if (input.policy === 'all') return 'policy';
  if (input.policy === 'externally_triggered' && input.externallyTriggered) return 'policy';
  return null;
}
