/**
 * deployments_status and deployments_history — how a person's code
 * projects stand, for a chat or an agent run to read: each environment's
 * branches, the last deployment a pipeline reported, what runs there, and
 * how the deployed application says it is in its health check-ins.
 *
 * Read-only, and Renkei's own rows (lib/ci/deployment-status.ts): nothing
 * here calls the code host, and no variable, secret or token is in reach.
 * Registered only for someone with a Bitbucket or GitHub connection
 * (registry.ts), and answering only for code projects the caller owns or
 * was given — for an agent run, the run's owner. An agent that should act
 * on a change listens for it (the `deployments/*` trigger events) and
 * reads the rest here.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import {
  codeProjectsOf,
  deploymentHistory,
  projectStatus,
  statusText,
} from '@/lib/ci/deployment-status';

/** The connector key the deployment capabilities register under. */
export const DEPLOYMENTS_CONNECTOR = 'deployments';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const NO_SUBJECT = 'This caller has no recorded identity, so it has no code projects.';
const NOT_YOURS =
  'No code project with that id is yours or shared with you. Call deployments_status without a project to list them.';

export function registerDeploymentsTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'deployments_status',
    {
      title: 'Deployments · Read — Environments, deployments and application health',
      description:
        'How your code projects stand: for each environment, its branches, the last deployment ' +
        'its pipeline reported (started, succeeded or failed, with the commit), what is running ' +
        'there, and the health the deployed application reports in its check-ins — healthy, ' +
        'degraded, error, potentially failing (a check-in is overdue), failed (three missed in ' +
        'a row) or stopped. Covers the code projects you own and those shared with you; pass ' +
        'projectId for one. Read-only; shows no variables or secrets.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe('One code project’s id; omit for every code project you can open.'),
      }),
    },
    async ({ projectId }) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const projects = await codeProjectsOf(context.subject, projectId);
      if (projectId && projects.length === 0) return errText(NOT_YOURS);
      const now = new Date();
      const status = await Promise.all(projects.map((project) => projectStatus(project, now)));
      return textResult(statusText(status));
    }
  );

  server.registerTool(
    'deployments_history',
    {
      title: 'Deployments · Read — A project’s recent deployments',
      description:
        'The deployments one code project’s pipelines reported, newest first: environment, ' +
        'status, commit, branch, when, and the run on the code host. Pass environment to keep ' +
        'one environment’s. Read-only.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectId: z.string().describe('The code project’s id, from deployments_status.'),
        environment: z.string().optional().describe('An environment’s name, e.g. "production".'),
        limit: z.number().int().min(1).max(100).optional().describe('How many; 20 by default.'),
      }),
    },
    async ({ projectId, environment, limit }) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const [project] = await codeProjectsOf(context.subject, projectId);
      if (!project) return errText(NOT_YOURS);
      const rows = await deploymentHistory(project.id, environment ?? null, limit ?? 20);
      if (rows.length === 0) {
        return textResult(
          `No deployment of "${project.name}"${environment ? ` to ${environment}` : ''} has been reported.`
        );
      }
      return textResult(
        [
          `Deployments of "${project.name}", newest first:`,
          ...rows.map(
            (d) =>
              `- ${d.environment}: ${d.status}, commit ${d.commit.slice(0, 7)}${d.branch ? ` from ${d.branch}` : ''}, ${d.finishedAt ?? d.startedAt}${d.detail ? ` — ${d.detail}` : ''}${d.runUrl ? ` (${d.runUrl})` : ''}`
          ),
        ].join('\n')
      );
    }
  );
}
