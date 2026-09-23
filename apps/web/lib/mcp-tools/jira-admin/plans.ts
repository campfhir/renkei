/**
 * Plans (Advanced Roadmaps, a Premium feature) through Atlassian's Plans
 * REST API — which is marked EXPERIMENTAL, requires Administer Jira, and
 * accepts classic scopes only (the reason this connector's app is classic,
 * lib/atlassian-scopes.ts). Reads for now; creating and updating plans,
 * teams and capacity is a later stage (docs/project-management-design.md).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, jiraAdminGet, rec, records, str, textResult } from './client';

/** A plan's issue source, e.g. "Board 42" or "Project 10000" (resolved to a key when known). */
function sourceLabel(source: Record<string, unknown>, projectKeys: Map<string, string>): string {
  const type = str(source.type);
  const value = str(source.value);
  if (type === 'Project' && projectKeys.has(value)) return `space ${projectKeys.get(value)}`;
  return `${type.toLowerCase() || 'source'} ${value}`;
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];
}

export async function registerPlanTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_list_plans',
    {
      title: 'Jira Admin · Read — List plans',
      description:
        'List Jira Plans (Advanced Roadmaps): name, id, status, and what each plan draws its ' +
        'work from (boards, spaces, filters). Plans is where timelines, cross-space ' +
        'dependencies and team capacity live. Needs Administer Jira; Atlassian marks the ' +
        'Plans API experimental.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        includeArchived: z.boolean().describe('Also list archived plans').optional(),
        includeTrashed: z.boolean().describe('Also list plans in the trash').optional(),
        cursor: z.string().describe('The nextPageCursor from a previous call').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const query = [
        'maxResults=50',
        `includeArchived=${args.includeArchived === true}`,
        `includeTrashed=${args.includeTrashed === true}`,
        ...(typeof args.cursor === 'string' && args.cursor
          ? [`cursor=${encodeURIComponent(args.cursor)}`]
          : []),
      ].join('&');
      const result = await jiraAdminGet(context, access, `/rest/api/3/plans/plan?${query}`);
      if (!result.ok) return errText(result.error);

      const plans = records(result.body);
      if (plans.length === 0) return textResult('No plans.');
      const lines = plans.map((plan) => {
        const sources = records(plan.issueSources).map((source) => sourceLabel(source, new Map()));
        return (
          `${str(plan.name) || '(unnamed)'} — id ${str(plan.id)} — ${str(plan.status) || 'status unknown'}` +
          (sources.length > 0 ? ` — from ${sources.join(', ')}` : '')
        );
      });
      const page = rec(result.body);
      if (page.last === false && str(page.nextPageCursor)) {
        lines.push(`\nMore plans: pass cursor "${str(page.nextPageCursor)}".`);
      }
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Plan, Id, Status, Sources) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'jira_admin_get_plan',
    {
      title: 'Jira Admin · Read — Get a plan',
      description:
        'One plan in full: its lead, where its work comes from, its scheduling settings ' +
        '(estimation unit, dependency handling, inferred dates, start/end date fields), ' +
        'exclusion rules, cross-space releases and teams. Needs Administer Jira; Atlassian ' +
        'marks the Plans API experimental.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        planId: z.string().min(1).describe('The plan id, from jira_admin_list_plans'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const planId = typeof args.planId === 'string' ? args.planId.trim() : '';
      if (!/^\d+$/.test(planId)) return errText('planId must be a plan id, e.g. 12');

      const [planResult, teamsResult] = await Promise.all([
        jiraAdminGet(context, access, `/rest/api/3/plans/plan/${planId}`),
        jiraAdminGet(context, access, `/rest/api/3/plans/plan/${planId}/team?maxResults=50`),
      ]);
      if (!planResult.ok) return errText(planResult.error);
      const plan = rec(planResult.body);

      const sources = records(plan.issueSources);
      const projectIds = sources
        .filter((source) => str(source.type) === 'Project')
        .map((source) => str(source.value))
        .filter(Boolean);
      const leadId = str(plan.leadAccountId);
      const [projects, lead] = await Promise.all([
        projectIds.length > 0
          ? jiraAdminGet(
              context,
              access,
              `/rest/api/3/project/search?maxResults=50&${projectIds.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`
            )
          : Promise.resolve(null),
        leadId
          ? jiraAdminGet(
              context,
              access,
              `/rest/api/3/user?accountId=${encodeURIComponent(leadId)}`
            )
          : Promise.resolve(null),
      ]);
      const projectKeys = new Map<string, string>();
      for (const project of projects?.ok ? records(projects.body) : []) {
        projectKeys.set(str(project.id), str(project.key));
      }

      const scheduling = rec(plan.scheduling);
      const dateField = (value: unknown) => {
        const field = rec(value);
        return str(field.type) === 'DateCustomField'
          ? `custom field ${str(field.dateCustomFieldId)}`
          : str(field.type);
      };
      const exclusions = rec(plan.exclusionRules);
      const exclusionParts = [
        typeof exclusions.numberOfDaysToShowCompletedIssues === 'number'
          ? `completed more than ${exclusions.numberOfDaysToShowCompletedIssues} days ago`
          : '',
        idsOf(exclusions.issueTypeIds).length > 0
          ? `${idsOf(exclusions.issueTypeIds).length} work type(s)`
          : '',
        idsOf(exclusions.workStatusIds).length > 0
          ? `${idsOf(exclusions.workStatusIds).length} status(es)`
          : '',
        idsOf(exclusions.releaseIds).length > 0
          ? `${idsOf(exclusions.releaseIds).length} release(s)`
          : '',
        idsOf(exclusions.issueIds).length > 0
          ? `${idsOf(exclusions.issueIds).length} issue(s)`
          : '',
      ].filter(Boolean);

      const leadName = lead?.ok ? str(rec(lead.body).displayName) : '';
      const lines = [
        `${str(plan.name) || '(unnamed)'} — id ${str(plan.id)} — ${str(plan.status) || 'status unknown'}`,
        `Lead: ${leadName || leadId || 'none'}`,
        `Work from: ${sources.map((source) => sourceLabel(source, projectKeys)).join(', ') || 'no sources'}`,
        `Scheduling: estimates in ${str(scheduling.estimation) || '?'}, dependencies ` +
          `${str(scheduling.dependencies).toLowerCase() || '?'}, inferred dates from ` +
          `${str(scheduling.inferredDates) || '?'}; start date = ${dateField(scheduling.startDate) || '?'}, ` +
          `end date = ${dateField(scheduling.endDate) || '?'}`,
        `Excluded: ${exclusionParts.join('; ') || 'nothing'}`,
      ];
      const releases = records(plan.crossProjectReleases);
      if (releases.length > 0) {
        lines.push(
          `Cross-space releases: ${releases.map((release) => `${str(release.name)} (${idsOf(release.releaseIds).length} release(s))`).join(', ')}`
        );
      }
      if (str(plan.lastSaved)) lines.push(`Last saved: ${str(plan.lastSaved)}`);

      if (!teamsResult.ok) {
        lines.push(`Teams: could not be read (${teamsResult.error})`);
      } else {
        const teams = records(teamsResult.body);
        lines.push(
          teams.length === 0
            ? 'Teams: none'
            : `Teams (${teams.length}): ${teams
                .map((team) =>
                  str(team.type) === 'PlanOnly'
                    ? `${str(team.name) || '(unnamed)'} (plan-only, id ${str(team.id)})`
                    : `Atlassian team ${str(team.id)}`
                )
                .join(', ')}`
        );
      }

      return textResult(lines.join('\n'));
    }
  );
}
