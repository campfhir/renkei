/**
 * When an Act step pauses for a person even though its author set no
 * `needsApproval` on it.
 *
 * An agent run acts on content it did not write: a mail that arrived, a
 * chat message, an API caller's payload. A step whose tool CHANGES a
 * system (an Act tool — readOnlyHint false) is where that content gets to
 * do something, so the org decides (`agentActStepsRequireApproval`,
 * @renkei/settings) which runs may act on it unattended:
 *
 *   - 'externally_triggered' (default): a run an event or a webhook started
 *     pauses before every Act call; a run a person started by hand, or a
 *     schedule, acts as written.
 *   - 'all': every run pauses before every Act call.
 *   - 'off': only the author's own `needsApproval` gates pause.
 *
 * Beneath the setting sits a fixed list of tools whose effect is hard to
 * take back or reaches other people — sending mail, merging a pull request,
 * deleting or sharing a document, directory writes — which pause in an
 * agent run under every setting. The list names registered tool names and
 * nothing else (apps/web's high-risk-tools test holds it to the catalog).
 *
 * Shared between the engine (which enforces it at the moment a step
 * reaches for a tool) and the web app (which tells authors what will
 * pause), so both answer from the same words.
 */

import type { ActApprovalPolicy } from '@renkei/settings';

/**
 * Tools an agent run ALWAYS pauses before, whatever the org's policy says.
 * Preview (`*_preview`) tools stand in for the directory writes that have
 * no plain Act tool — a card is what the step would call. `*_confirm`
 * tools are not here: they are app-only and never offered to a run at all.
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
  // Work items destroyed.
  'jira_delete_issue',
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

/** Why a call pauses: the author asked, the tool is on the fixed list, or the org's policy applies. */
export type ActApprovalReason = 'author' | 'high-risk' | 'policy';

export interface ActApprovalInput {
  tool: string;
  /**
   * The tool's read-or-act kind as the gateway declared it (from its
   * readOnlyHint). Null = not known, which reads as act: the capability
   * gate makes the same conservative call for an absent hint.
   */
  kind: ToolKindHint;
  /** The author's own `needsApproval` on the step offering the tool. */
  authorGated: boolean;
  policy: ActApprovalPolicy;
  externallyTriggered: boolean;
}

/** Null when the call may fire without a person; otherwise why it waits. */
export function actApprovalReason(input: ActApprovalInput): ActApprovalReason | null {
  if (input.authorGated) return 'author';
  if (isAlwaysApprovalTool(input.tool)) return 'high-risk';
  if (input.kind === 'read') return null;
  if (input.policy === 'all') return 'policy';
  if (input.policy === 'externally_triggered' && input.externallyTriggered) return 'policy';
  return null;
}
