import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { sizeRequestFromRow } from './postgres';
import type { CodeProjectStore } from './types';

export function memoryCodeProjects(tables: MemoryTables): CodeProjectStore {
  const requestsOf = (subject: string) =>
    orderBy(
      tables.select('sandbox_size_requests', (r) => r.subject === subject),
      [(r) => r.created_at, 'desc'],
      [(r) => r.id]
    );

  return {
    async workspaceBranches(workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const ids = new Set(workspaceIds.map((id) => tables.param('sandbox_workspaces', 'id', id)));
      return orderBy(
        tables.select(
          'sandbox_workspaces',
          (r) => ids.has(r.id) && r.status === 'ready' && r.branch !== ''
        ),
        [(r) => r.id]
      ).map((r) => ({ id: r.id, branch: r.branch }));
    },
    async usageByChat(projectId) {
      const project = tables.param('chats', 'project_id', projectId);
      const chats = new Set(
        tables.select('chats', (c) => c.project_id === project).map((c) => c.id)
      );
      const totals = new Map<string, { input: number; output: number }>();
      for (const turn of tables.select('chat_turns', (t) => chats.has(t.chat_id))) {
        const total = totals.get(turn.chat_id) ?? { input: 0, output: 0 };
        total.input += turn.input_tokens;
        total.output += turn.output_tokens;
        totals.set(turn.chat_id, total);
      }
      return orderBy([...totals], [([chatId]) => chatId]).map(([chatId, total]) => ({
        chatId,
        inputTokens: total.input,
        outputTokens: total.output,
      }));
    },
    async latestSizeRequest(subject) {
      const [row] = requestsOf(subject);
      return row ? sizeRequestFromRow(row) : null;
    },
    async createSizeRequest(request) {
      // The partial unique index (subject) WHERE status = 'pending'.
      if (
        tables.first(
          'sandbox_size_requests',
          (r) => r.subject === request.subject && r.status === 'pending'
        )
      ) {
        return null;
      }
      return sizeRequestFromRow(
        tables.insert('sandbox_size_requests', {
          subject: request.subject,
          requested_by: request.requestedBy,
          requested_bytes: request.requestedBytes,
          reason: request.reason,
        })
      );
    },
    async listSizeRequests(projectPrefix, limit) {
      const projects = tables.select('chat_projects');
      const rows = orderBy(
        tables.select('sandbox_size_requests'),
        [(r) => (r.status === 'pending' ? 0 : 1)],
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return page(rows, limit).map((row) => ({
        ...sizeRequestFromRow(row),
        projectName: projects.find((p) => `${projectPrefix}${p.id}` === row.subject)?.name ?? null,
      }));
    },
    async decideSizeRequest(decision) {
      const id = tables.param('sandbox_size_requests', 'id', decision.id);
      const [row] = tables.update(
        'sandbox_size_requests',
        (r) => r.id === id && r.status === 'pending',
        {
          status: decision.status,
          decided_by: decision.decidedBy,
          decided_at: new Date(),
          decision_note: decision.note,
          ...(decision.status === 'approved' && decision.approvedBytes !== undefined
            ? { requested_bytes: decision.approvedBytes }
            : {}),
        }
      );
      return row ? sizeRequestFromRow(row) : null;
    },
    async providerGrantScopes(subject, provider) {
      const [row] = orderBy(
        tables.select('provider_grants', (r) => r.provider === provider && r.subject === subject),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.provider_account_id]
      );
      return row
        ? { requestedScopes: row.requested_scopes, grantedScopes: row.granted_scopes }
        : null;
    },
  };
}
