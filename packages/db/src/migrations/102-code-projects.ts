import { Kysely } from 'kysely';

/**
 * Code projects — a chat project with a repository in it
 * (docs/sandbox-workspaces-design.md).
 *
 * A code project is modelled on a chat project rather than beside it:
 * it has the same instructions, memory, files, toolset, sharing and
 * chats, plus a repository the sandbox worker holds a checkout of and an
 * environment its commands run with. So it is a `chat_projects` row with
 * `kind = 'code'` and the repository named on it: `repo_provider`
 * (`atlassian-bitbucket`), `repo_full_name` (`workspace/repo`) and
 * `repo_branch`. `workspace_id` is the checkout on the sandbox worker — a
 * soft reference into `sandbox_workspaces`, which the worker owns and
 * sweeps; a code project whose checkout expired simply clones again. The
 * project's environment lives on the worker too (`sandbox_env_secrets`),
 * scoped by the project rather than by a person, so every chat in the
 * project runs with the same variables.
 *
 * `kind` defaults to `chat`, so every existing project is exactly what it
 * was; the Chat and Code sections each list their own kind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_projects')
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('chat'))
    .execute();
  await db.schema.alterTable('chat_projects').addColumn('repo_provider', 'varchar(32)').execute();
  await db.schema.alterTable('chat_projects').addColumn('repo_full_name', 'varchar(255)').execute();
  await db.schema.alterTable('chat_projects').addColumn('repo_branch', 'varchar(255)').execute();
  await db.schema.alterTable('chat_projects').addColumn('workspace_id', 'uuid').execute();

  await db.schema
    .createIndex('idx_chat_projects_kind')
    .on('chat_projects')
    .columns(['tenant_id', 'kind'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_chat_projects_kind').execute();
  await db.schema.alterTable('chat_projects').dropColumn('workspace_id').execute();
  await db.schema.alterTable('chat_projects').dropColumn('repo_branch').execute();
  await db.schema.alterTable('chat_projects').dropColumn('repo_full_name').execute();
  await db.schema.alterTable('chat_projects').dropColumn('repo_provider').execute();
  await db.schema.alterTable('chat_projects').dropColumn('kind').execute();
}
