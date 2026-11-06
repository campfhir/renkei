import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { chatTaskFromRow, chatTaskWaitFromRow } from './postgres';
import type { ChatTaskStore } from './types';

export function memoryChatTasks(tables: MemoryTables): ChatTaskStore {
  const ofChat = (chatId: string) =>
    orderBy(
      tables.select('chat_tasks', (r) => r.chat_id === chatId),
      [(r) => r.number]
    );

  return {
    async list(chatId) {
      return ofChat(chatId).map(chatTaskFromRow);
    },
    async get(chatId, id) {
      const wanted = id;
      const row = tables.first('chat_tasks', (r) => r.chat_id === chatId && r.id === wanted);
      return row ? chatTaskFromRow(row) : null;
    },
    async create(task) {
      const top = ofChat(task.chatId).reduce((max, r) => Math.max(max, r.number), 0);
      const now = new Date();
      const row = tables.insert('chat_tasks', {
        id: globalThis.crypto.randomUUID(),
        chat_id: task.chatId,
        parent_id: task.parentId,
        number: top + 1,
        title: task.title,
        detail: task.detail,
        status: task.status,
        progress: null,
        progress_note: null,
        result: null,
        depends_on: toJson(task.dependsOn),
        created_by: task.createdBy,
        created_at: now,
        updated_at: now,
        started_at: task.startedAt,
        finished_at: null,
      });
      return chatTaskFromRow(row);
    },
    async update(chatId, id, patch) {
      const wanted = id;
      const [row] = tables.update('chat_tasks', (r) => r.chat_id === chatId && r.id === wanted, {
        updated_at: new Date(),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
        ...(patch.progressNote !== undefined ? { progress_note: patch.progressNote } : {}),
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.dependsOn !== undefined ? { depends_on: toJson(patch.dependsOn) } : {}),
        ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
        ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}),
      });
      return row ? chatTaskFromRow(row) : null;
    },
    async delete(chatId, ids) {
      // The cascade on parent_id, by hand: the named tasks and every subtask beneath.
      const rows = tables.select('chat_tasks', (r) => r.chat_id === chatId);
      const gone = new Set(rows.filter((r) => ids.includes(r.id)).map((r) => r.id));
      for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) {
          if (r.parent_id !== null && gone.has(r.parent_id) && !gone.has(r.id)) {
            gone.add(r.id);
            grew = true;
          }
        }
      }
      if (gone.size === 0) return 0;
      tables.delete('chat_tasks', (r) => r.chat_id === chatId && gone.has(r.id));
      for (const r of tables.select('chat_tasks', (row) => row.chat_id === chatId)) {
        const deps = chatTaskFromRow(r).dependsOn;
        if (!deps.some((dep) => gone.has(dep))) continue;
        const wanted = r.id;
        tables.update('chat_tasks', (row) => row.id === wanted, {
          depends_on: toJson(deps.filter((dep) => !gone.has(dep))),
          updated_at: new Date(),
        });
      }
      return gone.size;
    },
    async getWait(chatId) {
      const row = tables.first('chat_task_waits', (r) => r.chat_id === chatId);
      return row ? chatTaskWaitFromRow(row) : null;
    },
    async putWait(wait) {
      tables.delete('chat_task_waits', (r) => r.chat_id === wait.chatId);
      const row = tables.insert('chat_task_waits', {
        chat_id: wait.chatId,
        task_ids: toJson(wait.taskIds),
        events: toJson(wait.events),
        mode: wait.mode,
        deadline_at: wait.deadlineAt,
        subject: wait.subject,
        roles: toJson(wait.roles),
        created_at: new Date(),
      });
      return chatTaskWaitFromRow(row);
    },
    async clearWait(chatId) {
      return tables.delete('chat_task_waits', (r) => r.chat_id === chatId).length > 0;
    },
    async listDueWaits(now, limit) {
      const due = tables.select(
        'chat_task_waits',
        (r) => r.deadline_at !== null && r.deadline_at.getTime() <= now.getTime()
      );
      return page(orderBy(due, [(r) => r.deadline_at], [(r) => r.chat_id]), limit).map(
        chatTaskWaitFromRow
      );
    },
  };
}
