/**
 * The card tools — how users and (mostly) agents put informational cards
 * on the Renkei feed, and manage them afterwards.
 *
 * The use case that forced these: a morning-summary agent that reads the
 * owner's overnight mail and messages and leaves "here's what you missed"
 * cards. Before this, an agent had no way to persist anything in Renkei —
 * it could only mail or message its owner.
 *
 * Ground rules, each load-bearing:
 *
 *  - MCP-created cards are always `kind: 'info'` and always OWNER-SCOPED
 *    (`owner_subject` = the caller; for an agent run, its owner). Action
 *    cards stay the ambient pipeline's job — an agent must not be able to
 *    stage an executable suggestion on someone's feed.
 *  - Only MCP-authored cards (`created_by IS NOT NULL`) can be updated,
 *    and only by their owner, and only while 'suggested'. Pipeline cards
 *    and decided cards are audit trail — immutable from here.
 *  - Lifecycle vocabulary is migration 015/024's, unchanged: an info card
 *    is born 'suggested' (= on the feed, awaiting acknowledgment);
 *    DISMISS is the acknowledgment and archives in the same stroke;
 *    ARCHIVE alone applies to already-decided cards. Guards live in the
 *    UPDATE's WHERE clause (the decision route's optimistic-claim idiom),
 *    so two racing calls cannot both win.
 *
 * No preview/confirm pair on purpose: the card feed IS the review
 * surface — a preview of a card would be a card about a card.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'kysely';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import { logger } from '@/lib/logger';

/** The connector key the card capabilities register under. */
export const CARDS_CONNECTOR = 'cards';

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 10_000;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const NO_SUBJECT = 'This caller has no recorded identity, so it cannot own cards.';

export function registerCardTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'card_create',
    {
      title: 'Cards · Act — Put a card on your Renkei feed',
      description:
        'Create an informational card on YOUR Renkei feed (e.g. a morning summary, a ' +
        'heads-up). The card is visible only to you, carries no executable action, and ' +
        'stays on the feed until you dismiss it. Returns the cardId.',
      // Writes to Renkei's own feed, never to a provider — but it is a
      // write, so readOnlyHint is false: org read-only mode disables it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        title: z.string().min(1).max(MAX_TITLE_CHARS).describe('Card headline'),
        summary: z
          .string()
          .min(1)
          .max(MAX_SUMMARY_CHARS)
          .describe('The card body (plain text; newlines preserved)'),
        evidence: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional structured context shown with the card (source refs, excerpts)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const subject = context.subject;
      if (!subject) return errText(NO_SUBJECT);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const summary = typeof args.summary === 'string' ? args.summary : '';
      if (!title || !summary) return errText('Both title and summary are required.');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const cardId = randomUUID();
      await dbResult.val
        .insertInto('actionable_items')
        .values({
          id: cardId,
          tenant_id: context.tenantId,
          source: context.agent ? 'agent' : 'mcp',
          kind: 'info',
          title,
          summary,
          evidence: JSON.stringify(
            typeof args.evidence === 'object' && args.evidence !== null ? args.evidence : {}
          ),
          suggested_action: null,
          owner_subject: subject,
          created_by: subject,
          created_by_agent_id: context.agent?.agentId ?? null,
        })
        .execute();

      logger.info('card_create put a card on the feed', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        cardId,
        byAgent: Boolean(context.agent),
      });
      return textResult(`Card created. cardId: ${cardId}`);
    }
  );

  server.registerTool(
    'card_update',
    {
      title: 'Cards · Act — Update one of your cards',
      description:
        'Update the title, summary or evidence of a card YOU created over MCP that has not ' +
        'been dismissed yet. Cards from the ambient pipeline and decided cards cannot be ' +
        'changed.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cardId: z.string().min(1).describe('The cardId returned by card_create'),
        title: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
        summary: z.string().min(1).max(MAX_SUMMARY_CHARS).optional(),
        evidence: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const subject = context.subject;
      if (!subject) return errText(NO_SUBJECT);
      const cardId = typeof args.cardId === 'string' ? args.cardId.trim() : '';
      if (!cardId) return errText('cardId is required.');
      const title = typeof args.title === 'string' ? args.title.trim() : undefined;
      const summary = typeof args.summary === 'string' ? args.summary : undefined;
      const evidence =
        typeof args.evidence === 'object' && args.evidence !== null ? args.evidence : undefined;
      if (title === undefined && summary === undefined && evidence === undefined) {
        return errText('Nothing to update — pass a new title, summary, or evidence.');
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      // Every guard is in the WHERE: zero rows means "not yours to change",
      // whatever the exact reason — existence is not probed separately, so
      // this tool cannot be used to test other people's card ids.
      const updated = await dbResult.val
        .updateTable('actionable_items')
        .set({
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(evidence !== undefined ? { evidence: JSON.stringify(evidence) } : {}),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', cardId)
        .where('tenant_id', '=', context.tenantId)
        .where('owner_subject', '=', subject)
        .where('created_by', 'is not', null)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) === 0) {
        return errText(
          'No updatable card with that id: it does not exist, is not yours, was not created ' +
            'over MCP, or has already been dismissed.'
        );
      }
      return textResult('Card updated.');
    }
  );

  server.registerTool(
    'card_dismiss',
    {
      title: 'Cards · Act — Dismiss one of your cards',
      description:
        'Acknowledge and remove one of YOUR cards from the feed. Dismissing also archives ' +
        'it; the history view still shows it.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cardId: z.string().min(1).describe('The card to dismiss'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const subject = context.subject;
      if (!subject) return errText(NO_SUBJECT);
      const cardId = typeof args.cardId === 'string' ? args.cardId.trim() : '';
      if (!cardId) return errText('cardId is required.');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      // Mirrors the decision route's dismiss branch, owner-scoped: the
      // status guard is the optimistic claim, so a racing web dismissal
      // and this call cannot both record a decision.
      const updated = await dbResult.val
        .updateTable('actionable_items')
        .set({
          status: 'dismissed',
          decided_by: subject,
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
          archived_by: subject,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', cardId)
        .where('tenant_id', '=', context.tenantId)
        .where('owner_subject', '=', subject)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) === 0) {
        return errText(
          'No dismissable card with that id: it does not exist, is not yours, or was already decided.'
        );
      }
      return textResult('Card dismissed.');
    }
  );

  server.registerTool(
    'card_archive',
    {
      title: 'Cards · Act — Archive one of your decided cards',
      description:
        'Remove an already-decided card of YOURS (executed, failed, or dismissed) from the ' +
        "default feed view. A card still awaiting a decision can't be archived — dismiss it " +
        'instead, so nothing leaves the feed undecided.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cardId: z.string().min(1).describe('The card to archive'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const subject = context.subject;
      if (!subject) return errText(NO_SUBJECT);
      const cardId = typeof args.cardId === 'string' ? args.cardId.trim() : '';
      if (!cardId) return errText('cardId is required.');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const updated = await dbResult.val
        .updateTable('actionable_items')
        .set({ archived_at: sql`NOW()`, archived_by: subject, updated_at: sql`NOW()` })
        .where('id', '=', cardId)
        .where('tenant_id', '=', context.tenantId)
        .where('owner_subject', '=', subject)
        .where('status', '!=', 'suggested')
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) === 0) {
        return errText(
          'No archivable card with that id: it does not exist, is not yours, is still ' +
            'awaiting a decision (dismiss it instead), or is already archived.'
        );
      }
      return textResult('Card archived.');
    }
  );

  server.registerTool(
    'card_list',
    {
      title: 'Cards · Read — List your feed cards',
      description:
        "The Renkei card feed as YOU see it: your own cards plus the tenant's shared ones, " +
        'newest first, with cardIds. Two kinds land here and they are answered differently: ' +
        'an "info" card is a note that stays until you acknowledge it with card_dismiss, ' +
        'while an "approval" card is an agent run PAUSED on your decision — it names the run ' +
        'it is holding up, and agent_approval_decide is what answers it (agent_approvals_list ' +
        'shows those on their own, with the time left before each times out).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        status: z
          .enum(['suggested', 'approved', 'executed', 'failed', 'dismissed'])
          .optional()
          .describe('Only cards in this state'),
        includeArchived: z.boolean().optional().describe('Include archived cards (default false)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max cards (default 20)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const subject = context.subject;
      if (!subject) return errText(NO_SUBJECT);
      const limit =
        typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 20;

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      let query = dbResult.val
        .selectFrom('actionable_items as c')
        // An approval card belongs to a run of an agent; the join is left
        // because an info card belongs to neither.
        .leftJoin('agents as a', 'a.id', 'c.created_by_agent_id')
        .select([
          'c.id as id',
          'c.kind as kind',
          'c.source as source',
          'c.status as status',
          'c.title as title',
          'c.summary as summary',
          'c.created_at as created_at',
          'c.archived_at as archived_at',
          'c.run_id as runId',
          'a.id as agentId',
          'a.name as agentName',
        ])
        .where('c.tenant_id', '=', context.tenantId)
        // The same visibility rule as the web feed: mine, or tenant-wide.
        .where((eb) =>
          eb.or([eb('c.owner_subject', 'is', null), eb('c.owner_subject', '=', subject)])
        )
        .orderBy('c.created_at', 'desc')
        .limit(limit);
      if (typeof args.status === 'string') query = query.where('c.status', '=', args.status);
      if (args.includeArchived !== true) query = query.where('c.archived_at', 'is', null);
      const rows = await query.execute();

      if (rows.length === 0) return textResult('No cards match.');
      const lines = [`${rows.length} card(s), newest first:`];
      for (const row of rows) {
        const summary = row.summary ?? '';
        const excerpt = summary.length <= 200 ? summary : `${summary.slice(0, 199)}…`;
        // An approval or question card is a run waiting on a person, and a
        // caller that cannot tell it from a note treats a paused agent as
        // something to acknowledge — or leaves it sitting, which is the
        // same outcome. Its run is the context that makes it decidable,
        // and `source` says who put the card here, which was fetched and
        // then dropped.
        const pauseKind = row.kind === 'approval' || row.kind === 'question' ? row.kind : null;
        const decideWith =
          row.kind === 'approval' ? 'agent_approval_decide' : 'agent_question_answer';
        lines.push(
          '',
          `- ${row.title} — ${row.kind} · ${row.status} · from ${row.source}` +
            `${row.archived_at ? ' · archived' : ''} — ${new Date(row.created_at).toISOString()}`,
          `  cardId: ${row.id}`,
          ...(pauseKind && row.runId
            ? [
                `  Paused run ${row.runId}` +
                  `${row.agentName ? ` of agent "${row.agentName}" (${row.agentId})` : ''}` +
                  `${row.status === 'suggested' ? ` — decide it with ${decideWith}` : ''}`,
              ]
            : []),
          `  ${excerpt}`
        );
      }
      return textResult(lines.join('\n'));
    }
  );
}
