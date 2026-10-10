import { Kysely, sql } from 'kysely';

/**
 * One organization per deployment.
 *
 * Renkei no longer models several organizations in one database: a
 * deployment IS an organization. The `tenants` table and every
 * `tenant_id` column go, the three organization-level tables keep their
 * rows under plainer names (`tenant_settings` → `settings`, `tenant_oidc`
 * → `oidc_config`, `tenant_jira_sites` → `jira_sites`), and
 * `tenant_domains` (the sign-in page's email-domain routing) is dropped
 * with the discovery it served. Every primary key, unique constraint,
 * index and foreign key that included the column is recreated without
 * it — the lists below were generated from the live catalog, so they
 * name exactly what the previous 152 migrations built.
 *
 * A database holding more than one organization cannot be merged by
 * this migration (rows that differed only by organization would collide
 * on the narrowed keys), so it refuses, by design, until the operator
 * has moved the other organizations out. A database with none is fine:
 * the deployment is set up on first sign-in.
 */

/** Every table that carried the column, by its name after the renames. */
const TABLES = [
  'actionable_items',
  'admanager_instance_connections',
  'admanager_instances',
  'agent_access_grants',
  'agent_drafts',
  'agent_jobs',
  'agent_jobs_dead_letters',
  'agent_memories',
  'agent_notifications',
  'agent_optimizations',
  'agent_run_counters',
  'agent_run_log',
  'agent_run_steps',
  'agent_runs',
  'agent_trigger_firings',
  'agent_triggers',
  'agents',
  'audit_events',
  'batch_job_messages',
  'batch_job_messages_dead_letters',
  'batch_job_schedules',
  'batch_jobs',
  'batch_processed_files',
  'chat_attachments',
  'chat_messages',
  'chat_presence',
  'chat_project_memories',
  'chat_projects',
  'chat_queued_sends',
  'chat_subagent_runs',
  'chat_summaries',
  'chat_turns',
  'chat_user_memories',
  'chat_widget_decisions',
  'chats',
  'coach_mark_progress',
  'code_language_gaps',
  'code_project_templates',
  'code_service_image_rules',
  'connector_configs',
  'content_watches',
  'delegate_access_events',
  'delegate_git_tickets',
  'device_key_requests',
  'email_classification_log',
  'email_classifier_rules',
  'email_cleaner_scripts',
  'email_extraction_templates',
  'embedding_jobs',
  'embedding_jobs_dead_letters',
  'events',
  'events_dead_letters',
  'file_share_connections',
  'file_shares',
  'identities',
  'image_usage',
  'jira_admin_change_requests',
  'jira_admin_space_templates',
  'jira_sessions',
  'key_delegations',
  'knowledge_chunks',
  'knowledge_reindex_runs',
  'llm_calls',
  'llm_model_configs',
  'mail_bulk_jobs',
  'mirth_instance_connections',
  'mirth_instances',
  'oauth_access_tokens',
  'oauth_authorization_codes',
  'oauth_clients',
  'oauth_consent_requests',
  'oauth_refresh_tokens',
  'oidc_role_mappings',
  'operator_sessions',
  'pending_oidc_signin',
  'phi_access_events',
  'pipeline_templates',
  'pr_subscriptions',
  'prompt_libraries',
  'prompts',
  'provider_grants',
  'provider_refresh_locks',
  'push_subscriptions',
  'resource_access_grants',
  'resource_key_grants',
  'resource_keys',
  'sandbox_env_secrets',
  'sandbox_files',
  'sandbox_secrets',
  'sandbox_services',
  'sandbox_size_requests',
  'sandbox_workspaces',
  'schedule_calendars',
  'sessions',
  'jira_sites',
  'oidc_config',
  'settings',
  'tool_calls',
  'upload_slots',
  'user_encryption_keys',
  'user_preferences',
  'voice_usage',
  'webex_dirty_windows',
  'webex_sent_messages',
  'webhook_subscriptions',
];

/** Keys and foreign keys that included the column, recreated without it. */
const CONSTRAINTS = [
  'ALTER TABLE jira_sessions ADD CONSTRAINT jira_sessions_unique UNIQUE (account_id, user_agent, ip_address)',
  'ALTER TABLE oidc_role_mappings ADD CONSTRAINT oidc_role_mappings_idp_unique UNIQUE (idp_role)',
  'ALTER TABLE provider_grants ADD CONSTRAINT provider_grants_pk PRIMARY KEY (provider, provider_account_id)',
  'ALTER TABLE provider_refresh_locks ADD CONSTRAINT provider_refresh_locks_pk PRIMARY KEY (provider, account_id)',
  'ALTER TABLE connector_configs ADD CONSTRAINT connector_configs_pk PRIMARY KEY (connector)',
  'ALTER TABLE settings ADD CONSTRAINT tenant_settings_pk PRIMARY KEY (key)',
  'ALTER TABLE identities ADD CONSTRAINT identities_pk PRIMARY KEY (subject)',
  'ALTER TABLE llm_model_configs ADD CONSTRAINT llm_model_configs_label UNIQUE (label)',
  'ALTER TABLE agents ADD CONSTRAINT agents_name UNIQUE (name)',
  'ALTER TABLE agent_run_counters ADD CONSTRAINT pk_agent_run_counters PRIMARY KEY (agent_id, day)',
  'ALTER TABLE webex_sent_messages ADD CONSTRAINT webex_sent_messages_pkey PRIMARY KEY (message_id)',
  'ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (subject, key)',
  'ALTER TABLE file_share_connections ADD CONSTRAINT file_share_connections_pk PRIMARY KEY (share_id, subject)',
  'ALTER TABLE batch_job_schedules ADD CONSTRAINT batch_job_schedules_name UNIQUE (name)',
  'ALTER TABLE webex_dirty_windows ADD CONSTRAINT webex_dirty_windows_pkey PRIMARY KEY (room_id, day)',
  'ALTER TABLE batch_processed_files ADD CONSTRAINT batch_processed_files_hash UNIQUE (share_id, content_hash)',
  'ALTER TABLE mirth_instance_connections ADD CONSTRAINT mirth_instance_connections_pk PRIMARY KEY (instance_id, subject)',
  'ALTER TABLE coach_mark_progress ADD CONSTRAINT coach_mark_progress_pkey PRIMARY KEY (subject, tour_id)',
  'ALTER TABLE chat_presence ADD CONSTRAINT chat_presence_pkey PRIMARY KEY (subject, chat_id)',
  'ALTER TABLE code_language_gaps ADD CONSTRAINT code_language_gaps_key UNIQUE (extension, language, reason)',
  'ALTER TABLE admanager_instance_connections ADD CONSTRAINT admanager_instance_connections_pk PRIMARY KEY (instance_id, subject)',
  'ALTER TABLE chat_widget_decisions ADD CONSTRAINT chat_widget_decisions_pkey PRIMARY KEY (state_key)',
  'ALTER TABLE chat_queued_sends ADD CONSTRAINT chat_queued_sends_pkey PRIMARY KEY (chat_id)',
  'ALTER TABLE user_encryption_keys ADD CONSTRAINT user_encryption_keys_pk PRIMARY KEY (subject)',
  'ALTER TABLE key_delegations ADD CONSTRAINT key_delegations_person FOREIGN KEY (subject) REFERENCES user_encryption_keys(subject) ON DELETE CASCADE',
];

/** Indexes that included the column, recreated without it (those on it alone are simply gone). */
const INDEXES = [
  'CREATE INDEX idx_actionable_items_feed ON actionable_items USING btree (status, created_at)',
  'CREATE INDEX idx_actionable_items_owner_all ON actionable_items USING btree (owner_subject, created_at DESC)',
  'CREATE INDEX idx_actionable_items_owner_unarchived ON actionable_items USING btree (owner_subject, created_at DESC) WHERE (archived_at IS NULL)',
  'CREATE INDEX idx_actionable_items_unarchived ON actionable_items USING btree (created_at DESC) WHERE (archived_at IS NULL)',
  'CREATE INDEX idx_admanager_instance_connections_subject ON admanager_instance_connections USING btree (subject)',
  'CREATE UNIQUE INDEX idx_admanager_instances_name ON admanager_instances USING btree (name)',
  'CREATE INDEX idx_agent_access_grants_grantee ON agent_access_grants USING btree (grantee_subject)',
  'CREATE INDEX idx_agent_drafts_owner ON agent_drafts USING btree (owner_subject, created_at)',
  'CREATE INDEX idx_agent_memories_agent ON agent_memories USING btree (agent_id, kind, created_at)',
  'CREATE INDEX idx_agent_notifications_feed ON agent_notifications USING btree (subject, created_at DESC)',
  'CREATE INDEX idx_agent_notifications_prune ON agent_notifications USING btree (created_at)',
  'CREATE INDEX idx_agent_notifications_unread ON agent_notifications USING btree (subject, created_at DESC) WHERE (read_at IS NULL)',
  'CREATE INDEX idx_agent_optimizations_agent ON agent_optimizations USING btree (agent_id, created_at)',
  'CREATE INDEX idx_agent_run_log_agent ON agent_run_log USING btree (agent_id, created_at)',
  'CREATE INDEX idx_agent_run_log_owner ON agent_run_log USING btree (owner_subject, created_at)',
  'CREATE INDEX idx_agent_runs_agent_time ON agent_runs USING btree (agent_id, created_at)',
  "CREATE INDEX idx_agent_runs_live ON agent_runs USING btree (status) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]))",
  'CREATE INDEX idx_agent_runs_time ON agent_runs USING btree (created_at)',
  'CREATE INDEX idx_agent_triggers_agent ON agent_triggers USING btree (agent_id)',
  "CREATE INDEX idx_agent_triggers_event ON agent_triggers USING btree (event_source, event_type) WHERE (((kind)::text = 'event'::text) AND enabled)",
  'CREATE INDEX idx_agents_owner ON agents USING btree (owner_subject)',
  'CREATE INDEX idx_audit_events_time ON audit_events USING btree (created_at)',
  'CREATE INDEX idx_batch_job_schedules_owner ON batch_job_schedules USING btree (subject)',
  "CREATE INDEX idx_batch_jobs_live ON batch_jobs USING btree (status) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'discovering'::character varying, 'running'::character varying])::text[]))",
  'CREATE INDEX idx_batch_jobs_owner_time ON batch_jobs USING btree (subject, created_at)',
  'CREATE INDEX idx_batch_processed_files_path ON batch_processed_files USING btree (share_id, path)',
  'CREATE INDEX idx_chat_attachments_owner ON chat_attachments USING btree (owner_subject, created_at DESC)',
  'CREATE INDEX idx_chat_project_memories_project ON chat_project_memories USING btree (project_id, kind, created_at)',
  'CREATE INDEX idx_chat_projects_kind ON chat_projects USING btree (kind)',
  'CREATE INDEX idx_chat_projects_owner ON chat_projects USING btree (owner_subject, updated_at DESC)',
  'CREATE INDEX idx_chat_summaries_chat ON chat_summaries USING btree (chat_id, created_at DESC)',
  "CREATE UNIQUE INDEX chat_user_memories_summary ON chat_user_memories USING btree (owner_subject) WHERE ((kind)::text = 'summary'::text)",
  'CREATE INDEX idx_chat_user_memories_owner ON chat_user_memories USING btree (owner_subject, kind, created_at)',
  'CREATE INDEX idx_chat_widget_decisions_chat ON chat_widget_decisions USING btree (chat_id)',
  'CREATE INDEX idx_chats_owner ON chats USING btree (owner_subject, updated_at DESC)',
  'CREATE INDEX idx_chats_project ON chats USING btree (project_id, updated_at DESC)',
  'CREATE INDEX idx_coach_mark_progress_tour ON coach_mark_progress USING btree (tour_id, status)',
  'CREATE UNIQUE INDEX idx_code_project_templates_name ON code_project_templates USING btree (name)',
  'CREATE UNIQUE INDEX idx_code_service_image_rules_pattern ON code_service_image_rules USING btree (pattern)',
  'CREATE UNIQUE INDEX idx_content_watches_scope ON content_watches USING btree (provider, subject, scope_type, scope_key)',
  'CREATE INDEX delegate_access_events_idx ON delegate_access_events USING btree (created_at)',
  'CREATE INDEX idx_device_key_requests_person ON device_key_requests USING btree (subject)',
  'CREATE INDEX idx_email_classification_log_content_hash ON email_classification_log USING btree (content_hash)',
  'CREATE INDEX idx_email_classification_log_owner ON email_classification_log USING btree (owner_upn, created_at)',
  'CREATE UNIQUE INDEX idx_email_classification_log_ref ON email_classification_log USING btree (provider, ref_id)',
  'CREATE INDEX idx_email_classifier_rules_priority ON email_classifier_rules USING btree (priority)',
  "CREATE UNIQUE INDEX idx_email_extraction_templates_active ON email_extraction_templates USING btree (sender_key) WHERE ((status)::text = 'active'::text)",
  'CREATE INDEX idx_file_share_connections_subject ON file_share_connections USING btree (subject)',
  'CREATE UNIQUE INDEX idx_file_shares_name ON file_shares USING btree (name)',
  'CREATE INDEX identities_email_idx ON identities USING btree (email)',
  'CREATE INDEX idx_image_usage_subject ON image_usage USING btree (subject, created_at)',
  'CREATE INDEX idx_jira_admin_change_requests_owner ON jira_admin_change_requests USING btree (subject, created_at)',
  'CREATE UNIQUE INDEX idx_jira_admin_space_templates_name ON jira_admin_space_templates USING btree (cloud_id, name_key)',
  'CREATE INDEX idx_key_delegations_person ON key_delegations USING btree (subject)',
  'CREATE UNIQUE INDEX idx_knowledge_chunks_ref ON knowledge_chunks USING btree (provider, ref_id)',
  'CREATE INDEX idx_knowledge_chunks_ref_prefix ON knowledge_chunks USING btree (provider, ref_id text_pattern_ops)',
  'CREATE INDEX idx_knowledge_chunks_source_at ON knowledge_chunks USING btree (provider, source_at)',
  'CREATE INDEX idx_knowledge_reindex_runs ON knowledge_reindex_runs USING btree (created_at)',
  'CREATE INDEX idx_llm_calls_agent ON llm_calls USING btree (agent_id, created_at) WHERE (agent_id IS NOT NULL)',
  'CREATE INDEX idx_llm_calls_subject ON llm_calls USING btree (subject, created_at)',
  "CREATE INDEX idx_mail_bulk_jobs_live ON mail_bulk_jobs USING btree (status) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]))",
  'CREATE INDEX idx_mail_bulk_jobs_owner_time ON mail_bulk_jobs USING btree (subject, created_at)',
  'CREATE INDEX idx_mirth_instance_connections_subject ON mirth_instance_connections USING btree (subject)',
  'CREATE UNIQUE INDEX idx_mirth_instances_name ON mirth_instances USING btree (name)',
  'CREATE INDEX idx_oauth_refresh_tokens_family ON oauth_refresh_tokens USING btree (family_id)',
  'CREATE INDEX idx_phi_access_events_subject_time ON phi_access_events USING btree (subject, created_at DESC)',
  'CREATE INDEX idx_phi_access_events_time ON phi_access_events USING btree (created_at DESC)',
  'CREATE UNIQUE INDEX idx_pipeline_templates_provider_name ON pipeline_templates USING btree (provider, name)',
  "CREATE INDEX idx_pr_subscriptions_lookup ON pr_subscriptions USING btree (provider, repo_full_name, pr_number) WHERE ((status)::text = 'active'::text)",
  'CREATE UNIQUE INDEX idx_pr_subscriptions_unique_subscriber ON pr_subscriptions USING btree (provider, repo_full_name, pr_number, subscriber_subject)',
  'CREATE INDEX idx_prompt_libraries_owner ON prompt_libraries USING btree (owner_subject, updated_at DESC)',
  'CREATE INDEX idx_provider_grants_subject_provider ON provider_grants USING btree (subject, provider)',
  'CREATE UNIQUE INDEX idx_push_subscriptions_endpoint ON push_subscriptions USING btree (endpoint)',
  'CREATE INDEX idx_push_subscriptions_subject ON push_subscriptions USING btree (subject)',
  'CREATE INDEX idx_resource_access_grants_grantee ON resource_access_grants USING btree (grantee_subject, resource_kind)',
  'CREATE INDEX idx_resource_key_grants_holder ON resource_key_grants USING btree (holder)',
  'CREATE UNIQUE INDEX idx_sandbox_env_secrets_owner_name ON sandbox_env_secrets USING btree (subject, name)',
  'CREATE INDEX idx_sandbox_files_batch ON sandbox_files USING btree (batch_id)',
  'CREATE INDEX idx_sandbox_files_owner_time ON sandbox_files USING btree (subject, created_at)',
  'CREATE UNIQUE INDEX idx_sandbox_secrets_owner_name ON sandbox_secrets USING btree (subject, name)',
  'CREATE UNIQUE INDEX idx_sandbox_services_owner_name ON sandbox_services USING btree (subject, name)',
  "CREATE UNIQUE INDEX sandbox_size_requests_one_pending_idx ON sandbox_size_requests USING btree (subject) WHERE (status = 'pending'::text)",
  'CREATE INDEX sandbox_size_requests_subject_idx ON sandbox_size_requests USING btree (subject)',
  'CREATE INDEX sandbox_size_requests_status_idx ON sandbox_size_requests USING btree (status, created_at)',
  'CREATE INDEX idx_sandbox_workspaces_owner ON sandbox_workspaces USING btree (subject, created_at)',
  'CREATE UNIQUE INDEX idx_schedule_calendars_name ON schedule_calendars USING btree (name)',
  'CREATE INDEX idx_tool_calls_agent ON tool_calls USING btree (agent_id, started_at) WHERE (agent_id IS NOT NULL)',
  'CREATE INDEX idx_tool_calls_subject_time ON tool_calls USING btree (subject, started_at)',
  'CREATE INDEX idx_tool_calls_time ON tool_calls USING btree (started_at)',
  'CREATE INDEX idx_tool_calls_tool_time ON tool_calls USING btree (tool, started_at)',
  'CREATE INDEX idx_upload_slots_owner_time ON upload_slots USING btree (subject, created_at)',
  'CREATE INDEX idx_voice_usage_kind ON voice_usage USING btree (kind, created_at)',
  'CREATE INDEX idx_voice_usage_subject ON voice_usage USING btree (subject, created_at)',
  'CREATE UNIQUE INDEX idx_webhook_subscriptions_grant_resource ON webhook_subscriptions USING btree (provider, account_id, resource)',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const counted = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tenants`.execute(db);
  const organizations = counted.rows[0]?.n ?? 0;
  if (organizations > 1) {
    throw new Error(
      `This database holds ${organizations} organizations; a Renkei deployment now serves exactly one. ` +
        'Move the others out (or delete them) before running this migration.'
    );
  }

  await sql`DROP TABLE tenant_domains`.execute(db);
  await sql`ALTER TABLE tenant_settings RENAME TO settings`.execute(db);
  await sql`ALTER TABLE tenant_oidc RENAME TO oidc_config`.execute(db);
  await sql`ALTER TABLE tenant_jira_sites RENAME TO jira_sites`.execute(db);

  // CASCADE: the column is in primary keys, unique constraints, indexes
  // and one composite foreign key (key_delegations → user_encryption_keys);
  // all of them go with it and are rebuilt below.
  for (const table of TABLES) {
    await sql.raw(`ALTER TABLE ${table} DROP COLUMN tenant_id CASCADE`).execute(db);
  }
  for (const statement of CONSTRAINTS) {
    await sql.raw(statement).execute(db);
  }
  for (const statement of INDEXES) {
    await sql.raw(statement).execute(db);
  }
  // One identity provider per deployment: the row's former key was the
  // organization, and without one an insert needs something to conflict on.
  await sql`CREATE UNIQUE INDEX oidc_config_single ON oidc_config ((true))`.execute(db);

  // The pre-enrollment key-encryption keys (packages/user-keys/src/legacy.ts)
  // were derived with the organization id in the HKDF info. The row stays
  // readable only if that id is still known, so it becomes a setting.
  await sql`
    INSERT INTO settings (key, value)
    SELECT 'legacy_key_domain', to_jsonb(id::text) FROM tenants
    ON CONFLICT (key) DO NOTHING
  `.execute(db);

  await sql`DROP TABLE tenants`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    'The single-organization migration cannot be reversed: the organization ids it removed are gone. Restore the database from the backup taken before upgrading.'
  );
}
