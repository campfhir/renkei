/**
 * jira_admin_get_space_configuration — how one space is put together: its
 * work types, the schemes it runs on (work types, workflows, screens, field
 * configuration, permissions, notifications) and who holds each role.
 *
 * The sharing counts are the point of reading this before any change. A
 * scheme is not the space's own: every space using it changes with it. The
 * two schemes most often edited for one space's sake — workflows and screens
 * — say how many spaces share them, so a proposal can default to copying a
 * shared scheme rather than changing it under everyone.
 *
 * Team-managed spaces carry their configuration inside the space itself;
 * site schemes do not apply to them, and this says so instead of listing
 * the defaults Jira reports.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import type { JiraAdminAccess, JiraAdminResult } from './client';
import { errText, jiraAdminGet, rec, records, str, textResult } from './client';

/** Roles described, and members listed per role. */
const MAX_ROLES = 12;
const MAX_ACTORS = 20;

/** The one scheme a per-project lookup names for this space, if any. */
function schemeOf(result: JiraAdminResult, key: string): Record<string, unknown> | null {
  if (!result.ok) return null;
  const first = records(result.body)[0];
  const scheme = first ? rec(first[key]) : {};
  return Object.keys(scheme).length > 0 ? scheme : null;
}

function schemeLabel(scheme: Record<string, unknown> | null): string {
  if (!scheme) return 'could not be read';
  return `"${str(scheme.name) || '(unnamed)'}" (id ${str(scheme.id)})`;
}

/** "used by this space only" / "shared by 7 spaces" from a usage lookup. */
function sharingNote(count: number | null, more: boolean): string {
  if (count === null) return '';
  if (count <= 1 && !more) return ' — used by this space only';
  return ` — shared by ${count}${more ? '+' : ''} spaces (a change here changes all of them)`;
}

async function workflowSchemeSharing(
  context: MCPToolContext,
  access: JiraAdminAccess,
  schemeId: string
): Promise<string> {
  if (!schemeId) return '';
  const result = await jiraAdminGet(
    context,
    access,
    `/rest/api/3/workflowscheme/${encodeURIComponent(schemeId)}/projectUsages?maxResults=50`
  );
  if (!result.ok) return '';
  const projects = rec(rec(result.body).projects);
  const values = Array.isArray(projects.values) ? projects.values.length : 0;
  return sharingNote(values, Boolean(str(projects.nextPageToken)));
}

async function screenSchemeSharing(
  context: MCPToolContext,
  access: JiraAdminAccess,
  schemeId: string
): Promise<string> {
  if (!schemeId) return '';
  const result = await jiraAdminGet(
    context,
    access,
    `/rest/api/3/issuetypescreenscheme/${encodeURIComponent(schemeId)}/project?maxResults=50`
  );
  if (!result.ok) return '';
  const page = rec(result.body);
  const total = typeof page.total === 'number' ? page.total : records(result.body).length;
  return sharingNote(total, false);
}

/** Every role on the space with its members, users and groups alike. */
async function roleLines(
  context: MCPToolContext,
  access: JiraAdminAccess,
  spaceKey: string
): Promise<string[]> {
  const roles = await jiraAdminGet(
    context,
    access,
    `/rest/api/3/project/${encodeURIComponent(spaceKey)}/role`
  );
  if (!roles.ok) return [`Roles: could not be read (${roles.error})`];
  // { "Administrators": "https://…/role/10002", … } — the id is the URL's tail.
  const entries = Object.entries(rec(roles.body))
    .map(([name, url]) => ({ name, id: /\/role\/(\d+)$/.exec(str(url))?.[1] ?? '' }))
    .filter((role) => role.id);
  if (entries.length === 0) return ['Roles: none'];

  const shown = entries.slice(0, MAX_ROLES);
  const details = await Promise.all(
    shown.map((role) =>
      jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/${encodeURIComponent(spaceKey)}/role/${role.id}`
      )
    )
  );
  const lines = ['Roles:'];
  shown.forEach((role, index) => {
    const detail = details[index];
    if (!detail.ok) {
      lines.push(`  • ${role.name}: could not be read`);
      return;
    }
    const actors = records(rec(detail.body).actors);
    const names = actors.slice(0, MAX_ACTORS).map((actor) => {
      const group = rec(actor.actorGroup);
      return Object.keys(group).length > 0
        ? `group ${str(group.displayName) || str(group.name)}`
        : str(actor.displayName) || str(rec(actor.actorUser).accountId);
    });
    lines.push(
      `  • ${role.name}: ${names.length > 0 ? names.join(', ') : 'nobody'}` +
        (actors.length > names.length ? `, …and ${actors.length - names.length} more` : '')
    );
  });
  if (entries.length > shown.length) {
    lines.push(`  …and ${entries.length - shown.length} more role(s)`);
  }
  return lines;
}

export async function registerSpaceTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_get_space_configuration',
    {
      title: 'Jira Admin · Read — Get a space’s configuration',
      description:
        'How one Jira space (project) is configured: its work types; the schemes it runs on — ' +
        'work types, workflows, screens, field configuration, permissions, notifications — ' +
        'with how many spaces share the workflow and screen schemes; and who holds each role. ' +
        'Read this before proposing a change to a space: editing a shared scheme changes every ' +
        'space that uses it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        space: z.string().min(1).describe('The space (project) key or numeric id, e.g. OPS'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const reference = typeof args.space === 'string' ? args.space.trim() : '';
      if (!reference) return errText('space is required');

      const projectResult = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/${encodeURIComponent(reference)}?expand=lead,issueTypes`
      );
      if (!projectResult.ok) return errText(projectResult.error);
      const project = rec(projectResult.body);
      const id = str(project.id);
      const key = str(project.key) || reference;
      const teamManaged = project.simplified === true || project.style === 'next-gen';

      const workTypes = records(project.issueTypes).map((type) => str(type.name));
      const lines = [
        `${key} — ${str(project.name)} (id ${id}) · ${str(project.projectTypeKey) || 'unknown type'}` +
          ` · ${teamManaged ? 'team-managed' : 'company-managed'}` +
          (str(rec(project.lead).displayName)
            ? ` · lead: ${str(rec(project.lead).displayName)}`
            : ''),
        `Work types (${workTypes.length}): ${workTypes.join(', ') || 'none'}`,
        '',
      ];

      if (teamManaged) {
        lines.push(
          'Team-managed: this space keeps its work types, fields and workflow in its own ' +
            'settings; site schemes do not apply to it.'
        );
      } else {
        const byProject = `projectId=${encodeURIComponent(id)}`;
        const [
          workTypeScheme,
          workflowScheme,
          screenScheme,
          fieldScheme,
          permissions,
          notifications,
        ] = await Promise.all([
          jiraAdminGet(context, access, `/rest/api/3/issuetypescheme/project?${byProject}`),
          jiraAdminGet(context, access, `/rest/api/3/workflowscheme/project?${byProject}`),
          jiraAdminGet(context, access, `/rest/api/3/issuetypescreenscheme/project?${byProject}`),
          jiraAdminGet(
            context,
            access,
            `/rest/api/3/fieldconfigurationscheme/project?${byProject}`
          ),
          jiraAdminGet(
            context,
            access,
            `/rest/api/3/project/${encodeURIComponent(key)}/permissionscheme`
          ),
          jiraAdminGet(
            context,
            access,
            `/rest/api/3/project/${encodeURIComponent(key)}/notificationscheme`
          ),
        ]);

        const workflow = schemeOf(workflowScheme, 'workflowScheme');
        const screens = schemeOf(screenScheme, 'issueTypeScreenScheme');
        const [workflowSharing, screenSharing] = await Promise.all([
          workflowSchemeSharing(context, access, str(workflow?.id)),
          screenSchemeSharing(context, access, str(screens?.id)),
        ]);

        // A space on the system default field configuration has no scheme
        // row at all — that is an answer, not a failure.
        const fieldConfig = fieldScheme.ok
          ? (() => {
              const scheme = schemeOf(fieldScheme, 'fieldConfigurationScheme');
              return scheme ? schemeLabel(scheme) : 'the system default field configuration';
            })()
          : 'could not be read';

        lines.push(
          'Schemes:',
          `  • Work types: ${schemeLabel(schemeOf(workTypeScheme, 'issueTypeScheme'))}`,
          `  • Workflows: ${schemeLabel(workflow)}${workflowSharing}`
        );
        const mappings = Object.entries(rec(workflow?.issueTypeMappings));
        if (workflow && str(workflow.defaultWorkflow)) {
          lines.push(`      default workflow: ${str(workflow.defaultWorkflow)}`);
        }
        if (mappings.length > 0) {
          const nameOf = new Map(records(project.issueTypes).map((t) => [str(t.id), str(t.name)]));
          for (const [typeId, workflowName] of mappings) {
            lines.push(
              `      ${nameOf.get(typeId) || `work type ${typeId}`} → ${str(workflowName)}`
            );
          }
        }
        lines.push(
          `  • Screens: ${schemeLabel(screens)}${screenSharing}`,
          `  • Field configuration: ${fieldConfig}`,
          `  • Permissions: ${permissions.ok ? schemeLabel(rec(permissions.body)) : 'could not be read'}`,
          `  • Notifications: ${notifications.ok ? schemeLabel(rec(notifications.body)) : 'could not be read'}`
        );
      }

      lines.push('', ...(await roleLines(context, access, key)));
      return textResult(lines.join('\n'));
    }
  );
}
