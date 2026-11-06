import { Kysely, sql } from 'kysely';

/**
 * A chat's tasks (apps/web/lib/chat/tasks/): the plan a model keeps for
 * itself and its sub-agents — what to do, what is under way, what waits
 * on what — and the one wait a chat's model may suspend on until some of
 * them finish (`chat_task_waits`).
 *
 * `chat_tasks`: `number` is the task's short handle in its chat (#1, #2…),
 * handed out in order; `parent_id` makes a subtask (a parent's delete takes
 * its subtree); `depends_on` lists the ids of tasks that must be completed
 * before this one starts. Title, detail, progress note and result are
 * sealed under the chat's key, like its messages.
 *
 * `chat_task_waits`: at most one per chat. Which tasks it watches, the
 * finishes that wake it, whether any or all must finish, when it gives
 * up, and the session (subject and roles) the woken turn runs as. The
 * partial index serves the sweep that fires waits past their deadline.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE chat_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES chat_tasks(id) ON DELETE CASCADE,
      number integer NOT NULL,
      title text NOT NULL,
      detail text,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled')),
      progress smallint CHECK (progress BETWEEN 0 AND 100),
      progress_note text,
      result text,
      depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text NOT NULL DEFAULT 'assistant'
        CHECK (created_by IN ('assistant', 'subagent', 'person')),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      started_at timestamptz,
      finished_at timestamptz,
      UNIQUE (chat_id, number)
    )
  `.execute(db);
  await sql`CREATE INDEX chat_tasks_parent_idx ON chat_tasks (parent_id) WHERE parent_id IS NOT NULL`.execute(
    db
  );
  await sql`
    CREATE TABLE chat_task_waits (
      chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      task_ids jsonb NOT NULL,
      events jsonb NOT NULL,
      mode text NOT NULL CHECK (mode IN ('any', 'all')),
      deadline_at timestamptz,
      subject text NOT NULL,
      roles jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  await sql`CREATE INDEX chat_task_waits_deadline_idx ON chat_task_waits (deadline_at) WHERE deadline_at IS NOT NULL`.execute(
    db
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS chat_task_waits`.execute(db);
  await sql`DROP TABLE IF EXISTS chat_tasks`.execute(db);
}
