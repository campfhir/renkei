import { sql, type Kysely, type Selectable } from 'kysely';
import type { ChatTaskWaits, ChatTasks, DB } from '../../../db.types';
import type {
  ChatTaskCreator,
  ChatTaskRecord,
  ChatTaskStatus,
  ChatTaskStore,
  ChatTaskWaitEvent,
  ChatTaskWaitRecord,
} from './types';

const STATUSES: readonly ChatTaskStatus[] = [
  'pending',
  'in_progress',
  'waiting',
  'completed',
  'failed',
  'cancelled',
];
const EVENTS: readonly ChatTaskWaitEvent[] = ['completed', 'failed', 'cancelled'];

function statusOf(value: string): ChatTaskStatus {
  return STATUSES.find((status) => status === value) ?? 'pending';
}

function creatorOf(value: string): ChatTaskCreator {
  return value === 'subagent' || value === 'person' ? value : 'assistant';
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function chatTaskFromRow(row: Selectable<ChatTasks>): ChatTaskRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentId: row.parent_id,
    number: row.number,
    title: row.title,
    detail: row.detail,
    status: statusOf(row.status),
    progress: row.progress,
    progressNote: row.progress_note,
    result: row.result,
    dependsOn: stringsOf(row.depends_on),
    createdBy: creatorOf(row.created_by),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  };
}

export function chatTaskWaitFromRow(row: Selectable<ChatTaskWaits>): ChatTaskWaitRecord {
  return {
    chatId: row.chat_id,
    taskIds: stringsOf(row.task_ids),
    events: stringsOf(row.events).flatMap((e) => EVENTS.filter((event) => event === e)),
    mode: row.mode === 'any' ? 'any' : 'all',
    deadlineAt: row.deadline_at === null ? null : new Date(row.deadline_at),
    subject: row.subject,
    roles: stringsOf(row.roles),
    createdAt: new Date(row.created_at),
  };
}

export function postgresChatTasks(db: () => Kysely<DB>): ChatTaskStore {
  return {
    async list(chatId) {
      const rows = await db()
        .selectFrom('chat_tasks')
        .selectAll()
        .where('chat_id', '=', chatId)
        .orderBy('number')
        .execute();
      return rows.map(chatTaskFromRow);
    },
    async get(chatId, id) {
      const row = await db()
        .selectFrom('chat_tasks')
        .selectAll()
        .where('chat_id', '=', chatId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? chatTaskFromRow(row) : null;
    },
    async create(task) {
      return db()
        .transaction()
        .execute(async (trx) => {
          // Two tasks made at once in one chat (a model's parallel calls)
          // take numbers one after the other: the chat row is the lock.
          await trx
            .selectFrom('chats')
            .select('id')
            .where('id', '=', task.chatId)
            .forUpdate()
            .execute();
          const top = await trx
            .selectFrom('chat_tasks')
            .select(sql<number>`COALESCE(MAX(number), 0)`.as('top'))
            .where('chat_id', '=', task.chatId)
            .executeTakeFirstOrThrow();
          const row = await trx
            .insertInto('chat_tasks')
            .values({
              chat_id: task.chatId,
              parent_id: task.parentId,
              number: Number(top.top) + 1,
              title: task.title,
              detail: task.detail,
              status: task.status,
              depends_on: JSON.stringify(task.dependsOn),
              created_by: task.createdBy,
              started_at: task.startedAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return chatTaskFromRow(row);
        });
    },
    async update(chatId, id, patch) {
      const row = await db()
        .updateTable('chat_tasks')
        .set({
          updated_at: sql<Date>`NOW()`,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
          ...(patch.progressNote !== undefined ? { progress_note: patch.progressNote } : {}),
          ...(patch.result !== undefined ? { result: patch.result } : {}),
          ...(patch.dependsOn !== undefined ? { depends_on: JSON.stringify(patch.dependsOn) } : {}),
          ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
          ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}),
        })
        .where('chat_id', '=', chatId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? chatTaskFromRow(row) : null;
    },
    async delete(chatId, ids) {
      if (ids.length === 0) return 0;
      return db()
        .transaction()
        .execute(async (trx) => {
          // The subtree, so the ids stripped from `depends_on` include the
          // subtasks the cascade takes.
          const doomed = await sql<{ id: string }>`
            WITH RECURSIVE tree AS (
              SELECT id FROM chat_tasks WHERE chat_id = ${chatId} AND id IN (${sql.join(ids)})
              UNION
              SELECT t.id FROM chat_tasks t JOIN tree ON t.parent_id = tree.id
            )
            SELECT id FROM tree
          `.execute(trx);
          const gone = doomed.rows.map((row) => row.id);
          if (gone.length === 0) return 0;
          await sql`
            DELETE FROM chat_tasks WHERE chat_id = ${chatId} AND id IN (${sql.join(gone)})
          `.execute(trx);
          await sql`
            UPDATE chat_tasks
               SET depends_on = COALESCE(
                     (SELECT jsonb_agg(e ORDER BY ord)
                        FROM jsonb_array_elements(depends_on) WITH ORDINALITY AS d(e, ord)
                       WHERE NOT (e #>> '{}' = ANY(${gone}::text[]))),
                     '[]'::jsonb),
                   updated_at = NOW()
             WHERE chat_id = ${chatId} AND depends_on ?| ${gone}::text[]
          `.execute(trx);
          return gone.length;
        });
    },
    async getWait(chatId) {
      const row = await db()
        .selectFrom('chat_task_waits')
        .selectAll()
        .where('chat_id', '=', chatId)
        .executeTakeFirst();
      return row ? chatTaskWaitFromRow(row) : null;
    },
    async putWait(wait) {
      const values = {
        chat_id: wait.chatId,
        task_ids: JSON.stringify(wait.taskIds),
        events: JSON.stringify(wait.events),
        mode: wait.mode,
        deadline_at: wait.deadlineAt,
        subject: wait.subject,
        roles: JSON.stringify(wait.roles),
      };
      const { chat_id: _chatId, ...replace } = values;
      const row = await db()
        .insertInto('chat_task_waits')
        .values(values)
        .onConflict((oc) =>
          oc.column('chat_id').doUpdateSet({ ...replace, created_at: sql`NOW()` })
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return chatTaskWaitFromRow(row);
    },
    async clearWait(chatId) {
      const result = await db()
        .deleteFrom('chat_task_waits')
        .where('chat_id', '=', chatId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async listDueWaits(now, limit) {
      const rows = await db()
        .selectFrom('chat_task_waits')
        .selectAll()
        .where('deadline_at', 'is not', null)
        .where('deadline_at', '<=', now)
        .orderBy('deadline_at')
        .orderBy('chat_id')
        .limit(limit)
        .execute();
      return rows.map(chatTaskWaitFromRow);
    },
  };
}
