/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { confluenceGet, confluencePut, values, textResult, errText, str } from './client';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { ConfluenceAuth } from './confluence-auth';

function taskLine(task: Record<string, unknown>): string {
  return (
    `[${str(task.status) || 'incomplete'}] id: ${str(task.id)}` +
    (str(task.pageId) ? ` — page: ${str(task.pageId)}` : '') +
    (str(task.blogPostId) ? ` — blog post: ${str(task.blogPostId)}` : '') +
    (str(task.assignedTo) ? ` — assigned to: ${str(task.assignedTo)}` : '') +
    (str(task.dueAt) ? ` — due ${str(task.dueAt)}` : '')
  );
}

export async function registerTaskTools(
  server: McpServer,
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<void> {
  server.registerTool(
    'confluence_list_tasks',
    {
      title: 'Confluence · Read — List inline tasks',
      description:
        'List the checkbox tasks ("- [ ] ...") embedded in pages/blog posts across a space, or ' +
        'on one page/blog post. Tasks are authored by writing that Markdown checkbox syntax via ' +
        'confluence_create_page/confluence_update_page — there is no separate "create task" tool.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        spaceId: z.string().describe('Only tasks in this space').optional(),
        pageId: z.string().describe('Only tasks on this page').optional(),
        blogpostId: z.string().describe('Only tasks on this blog post').optional(),
        status: z
          .enum(['complete', 'incomplete'])
          .describe('Only tasks with this status')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`limit=${max}`];
      if (str(args.spaceId)) parts.push(`space-id=${encodeURIComponent(str(args.spaceId))}`);
      if (str(args.pageId)) parts.push(`page-id=${encodeURIComponent(str(args.pageId))}`);
      if (str(args.blogpostId))
        parts.push(`blogpost-id=${encodeURIComponent(str(args.blogpostId))}`);
      if (str(args.status)) parts.push(`status=${str(args.status)}`);
      const result = await confluenceGet(context, access, `/api/v2/tasks?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(taskLine);
      if (lines.length === 0) return textResult('No tasks.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a checklist grouped by status usually reads clearer than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_update_task_status',
    {
      title: 'Confluence · Act — Mark a task complete or incomplete',
      description:
        'Change a task’s checkbox state. This is the only mutation Confluence’s task API ' +
        'supports — the task’s text is edited by editing the page/blog post body itself.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        taskId: z.string().min(1).describe('Task id from confluence_list_tasks'),
        status: z.enum(['complete', 'incomplete']),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const taskId = str(args.taskId);
      if (!taskId) return errText('taskId is required');
      const status = str(args.status);
      if (!status) return errText('status is required');
      const result = await confluencePut(
        context,
        access,
        `/api/v2/tasks/${encodeURIComponent(taskId)}`,
        {
          status,
        }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Task marked ${status}.`);
    }
  );
}
