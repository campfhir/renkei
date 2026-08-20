/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Async Outlook bulk mail actions: the submit/status pair that replaced the
 * synchronous outlook_bulk_* act tools. A 100-message archive under Graph
 * throttling can run for minutes — past any request budget and past every
 * MCP client's patience — so the submit tool writes ONE mail_bulk_jobs row,
 * enqueues a bare { jobId } pointer (Decision #17: the web app is a queue
 * producer only), and returns immediately; apps/worker executes; the status
 * tool reads the row back.
 *
 * The status lookup is scoped by tenant_id AND subject — a job id alone
 * never reads another user's mailbox activity. Registration stays I/O-free
 * (the tool catalog re-runs registration through a collector): the database
 * and queue are touched only inside handler bodies.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { BATCH_CHUNK_SIZE } from '@renkei/connector-microsoft';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { logger } from '@/lib/logger';

const MAX_JOB_MESSAGES = 1_000;
const DEFAULT_JOB_MESSAGES = 500;

function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry)
    : [];
}

/** A rough happy-path ETA; throttling can stretch it well past this. */
function etaSecondsFor(count: number, twoPass: boolean): number {
  const chunks = Math.ceil(count / BATCH_CHUNK_SIZE) * (twoPass ? 2 : 1);
  return Math.ceil(chunks * 1.5 + 5);
}

const filtersSchema = z
  .object({
    folder: z
      .string()
      .describe('Folder id or well-known name (inbox, archive, …); omit for the whole mailbox')
      .optional(),
    isRead: z.boolean().describe('Only read (true) or unread (false) messages').optional(),
    flagStatus: z
      .enum(['flagged', 'complete', 'notFlagged'])
      .describe('Only messages with this follow-up flag state')
      .optional(),
    categories: z
      .array(z.string().min(1))
      .describe('Only messages carrying ALL of these categories')
      .optional(),
    hasAttachments: z.boolean().describe('Only messages with (or without) attachments').optional(),
    from: z.string().describe('Exact sender address').optional(),
    subjectContains: z
      .string()
      .describe('Substring match on the subject (matched while selecting)')
      .optional(),
    receivedAfter: z
      .string()
      .describe('ISO-8601 — only messages received on/after this time')
      .optional(),
    receivedBefore: z
      .string()
      .describe('ISO-8601 — only messages received before this time')
      .optional(),
    maxMessages: z
      .number()
      .int()
      .min(1)
      .max(MAX_JOB_MESSAGES)
      .describe(`How many matching messages the job may touch (default ${DEFAULT_JOB_MESSAGES})`)
      .optional(),
  })
  .describe(
    'Select messages by search instead of ids — the same filters as ' +
      'outlook_bulk_search_messages; the job resolves them server-side'
  );

export function registerBulkJobTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): void {
  server.registerTool(
    'outlook_start_bulk_mail_job',
    {
      title: 'Outlook · Act — Start a bulk mail job',
      description:
        'Act on up to 1000 messages as one ASYNC job — mark read/unread, flag, categorize, ' +
        'move, or archive (mark read + move). Returns a jobId immediately; poll ' +
        'outlook_get_bulk_mail_job for progress. Select by explicit messageIds (e.g. from ' +
        'outlook_bulk_search_messages) OR by filters the job resolves server-side — pass ' +
        'exactly one. A job already accepted runs to completion even if the org later flips ' +
        'read-only.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        action: z
          .enum(['markRead', 'flag', 'categorize', 'move', 'archive'])
          .describe('What to do to every selected message'),
        messageIds: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_JOB_MESSAGES)
          .describe('Explicit message ids — mutually exclusive with filters')
          .optional(),
        filters: filtersSchema.optional(),
        isRead: z
          .boolean()
          .describe('markRead: true to mark read (default), false to mark unread')
          .optional(),
        flagStatus: z
          .enum(['flagged', 'complete', 'notFlagged'])
          .describe('flag: the follow-up flag state to set (default "flagged")')
          .optional(),
        add: z.array(z.string().min(1)).describe('categorize: categories to add').optional(),
        remove: z.array(z.string().min(1)).describe('categorize: categories to remove').optional(),
        replace: z
          .array(z.string())
          .describe('categorize: replace the whole set ([] clears all)')
          .optional(),
        destinationFolder: z
          .string()
          .describe(
            'move: where to file them (required); archive: default "archive" — a folder id ' +
              'or well-known name'
          )
          .optional(),
        markRead: z
          .boolean()
          .describe('archive: also mark them read first (default true)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!context.subject) return errText('No signed-in identity on this request.');

      const messageIds = strings(args.messageIds);
      const hasIds = messageIds.length > 0;
      const filters =
        typeof args.filters === 'object' && args.filters !== null ? args.filters : null;
      if (hasIds === Boolean(filters)) {
        return errText('Provide exactly one of messageIds or filters.');
      }

      const action = str(args.action);
      const params: Record<string, unknown> = {};
      if (action === 'markRead') {
        params.isRead = args.isRead !== false;
      } else if (action === 'flag') {
        params.flagStatus = str(args.flagStatus) || 'flagged';
      } else if (action === 'categorize') {
        const add = strings(args.add);
        const remove = strings(args.remove);
        const replace = Array.isArray(args.replace) ? strings(args.replace) : null;
        if (!replace && add.length === 0 && remove.length === 0) {
          return errText('categorize needs add, remove, or replace.');
        }
        if (replace) params.replace = replace;
        if (add.length > 0) params.add = add;
        if (remove.length > 0) params.remove = remove;
      } else if (action === 'move') {
        if (!str(args.destinationFolder)) return errText('move needs destinationFolder.');
        params.destinationFolder = str(args.destinationFolder);
      } else if (action === 'archive') {
        params.destinationFolder = str(args.destinationFolder) || 'archive';
        params.markRead = args.markRead !== false;
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      const jobId = randomUUID();
      const selection = hasIds
        ? { messageIds }
        : {
            filters,
            maxMessages: Math.min(
              typeof filters?.maxMessages === 'number' ? filters.maxMessages : DEFAULT_JOB_MESSAGES,
              MAX_JOB_MESSAGES
            ),
          };
      await db
        .insertInto('mail_bulk_jobs')
        .values({
          id: jobId,
          tenant_id: context.tenantId,
          subject: context.subject,
          account_id: access.accountId,
          action,
          params: JSON.stringify(params),
          selection: JSON.stringify(selection),
        })
        .execute();

      const enqueued = await webhookEventsQueue().producer.enqueue({
        tenantId: context.tenantId,
        source: 'mailjobs',
        type: 'bulk-action',
        payload: { jobId },
        // Jobs for one mailbox stay serial; different mailboxes run freely.
        orderingKey: `mailjob:${context.tenantId}:${access.accountId}`,
      });
      if (!enqueued.ok) {
        // Don't leave a zombie 'queued' row nothing will ever pick up.
        await db
          .updateTable('mail_bulk_jobs')
          .set({ status: 'failed', last_error: 'could not enqueue the job' })
          .where('id', '=', jobId)
          .execute();
        return errText('The job could not be queued — try again.');
      }

      logger.info('outlook_start_bulk_mail_job accepted {jobId}', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        jobId,
        action,
      });
      const count = hasIds
        ? messageIds.length
        : typeof selection.maxMessages === 'number'
          ? selection.maxMessages
          : DEFAULT_JOB_MESSAGES;
      const eta = etaSecondsFor(count, action === 'archive' || action === 'categorize');
      return textResult(
        `Accepted bulk ${action} job ${jobId}` +
          (hasIds
            ? ` over ${messageIds.length} messages.`
            : ' (selection resolves when it runs).') +
          ` Rough ETA ~${eta}s — longer if Outlook throttles.` +
          ` Poll outlook_get_bulk_mail_job with this jobId for progress.`
      );
    }
  );

  server.registerTool(
    'outlook_get_bulk_mail_job',
    {
      title: 'Outlook · Read — Check a bulk mail job',
      description:
        'Progress and outcome of a job started by outlook_start_bulk_mail_job: status, ' +
        'succeeded/failed counts, and per-message failures (up to 20).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jobId: z.string().uuid().describe('The id outlook_start_bulk_mail_job returned'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!context.subject) return errText('No signed-in identity on this request.');
      const jobId = str(args.jobId);
      if (!jobId) return errText('jobId is required');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      // tenant AND subject are the security boundary: a job id alone must
      // never read someone else's mailbox activity. A foreign id is
      // indistinguishable from a nonexistent one.
      const job = await dbResult.val
        .selectFrom('mail_bulk_jobs')
        .selectAll()
        .where('id', '=', jobId)
        .where('tenant_id', '=', context.tenantId)
        .where('subject', '=', context.subject)
        .executeTakeFirst();
      if (!job) return errText('No such job.');

      const startedAt = job.started_at ? new Date(job.started_at).getTime() : null;
      const endedAt = job.finished_at ? new Date(job.finished_at).getTime() : null;
      const elapsedS =
        startedAt !== null ? Math.round(((endedAt ?? Date.now()) - startedAt) / 1000) : null;
      const lines = [
        `Job ${job.id} (${job.action}): ${job.status}.`,
        job.total !== null
          ? `Progress: ${job.succeeded} succeeded, ${job.failed} failed of ${job.total}.`
          : 'Selection not yet resolved.',
        ...(elapsedS !== null
          ? [`${job.status === 'running' ? 'Running' : 'Ran'} ${elapsedS}s.`]
          : []),
        ...(job.last_error ? [`Error: ${job.last_error}`] : []),
      ];
      const failures = Array.isArray(job.failures) ? job.failures : [];
      if (failures.length > 0) {
        lines.push('Failed messages:');
        for (const failure of failures) {
          if (typeof failure === 'object' && failure !== null && !Array.isArray(failure)) {
            lines.push(`  • ${str(failure.id)}: ${str(failure.error) || 'unknown error'}`);
          }
        }
      }
      if (job.status === 'queued' || job.status === 'running') {
        lines.push('Poll again in ~5s.');
      }
      return textResult(lines.join('\n'));
    }
  );
}
