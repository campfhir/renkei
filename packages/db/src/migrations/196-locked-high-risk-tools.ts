import { Kysely, sql } from 'kysely';

/**
 * The organization's locked high-risk tools: what used to be a fixed list
 * in code (@renkei/agents' ALWAYS_APPROVAL_TOOLS) becomes the
 * `locked_high_risk_tools` setting, which operators change on Settings
 * (@renkei/settings' lockedHighRiskTools). This seeds it with that list as
 * it stood, so nothing anyone's agents do changes on the day this runs:
 * tools whose effect is hard to take back or reaches other people. A
 * deployment that already has the setting keeps what it has.
 *
 * The names are frozen here on purpose. From now on the list is data; a
 * new tool becomes locked when an operator locks it, not when this file
 * changes.
 */
const SEED: readonly string[] = [
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
  // List rows destroyed.
  'sharepoint_delete_list_item',
  // A column and every value in it, with no recycle bin.
  'sharepoint_remove_list_column',
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
  // Fabric: what each environment deploys to, and on whose workspace —
  // its pipeline. Item changes are pull requests someone merges.
  'fabric_setup_pipeline_preview',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('locked_high_risk_tools', ${JSON.stringify(SEED)}::jsonb, NOW())
    ON CONFLICT (key) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM settings WHERE key = 'locked_high_risk_tools'`.execute(db);
}
