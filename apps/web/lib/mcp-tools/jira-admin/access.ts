/**
 * jira_admin_check_access — who the Jira Administration connection acts as,
 * and what they can administer. The first call to make when unsure whether
 * a configuration change is possible: Jira checks Administer Jira (site
 * configuration, Plans) or Administer Projects (one space's settings) on
 * every admin call, and this says which the connected person holds before
 * anything else answers 403.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, jiraAdminGet, rec, records, str, textResult } from './client';

/** Spaces listed before the rest is summarized as a count. */
const MAX_SPACES = 50;

export async function registerAccessTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_check_access',
    {
      title: 'Jira Admin · Read — What can I administer?',
      description:
        'Who the Jira Administration connection acts as, whether they hold Administer Jira ' +
        '(needed for site configuration — custom fields and their options, work types, ' +
        'workflows, schemes — and for Plans), and which spaces they can administer ' +
        '(Administer Projects). Call this first when unsure whether a configuration change ' +
        'is possible.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const [myself, permissions, spaces] = await Promise.all([
        jiraAdminGet(context, access, '/rest/api/3/myself'),
        jiraAdminGet(
          context,
          access,
          '/rest/api/3/mypermissions?permissions=ADMINISTER,ADMINISTER_PROJECTS'
        ),
        jiraAdminGet(
          context,
          access,
          `/rest/api/3/project/search?action=edit&orderBy=name&maxResults=${MAX_SPACES}`
        ),
      ]);
      if (!myself.ok) return errText(myself.error);
      if (!permissions.ok) return errText(permissions.error);

      const me = rec(myself.body);
      const held = rec(rec(permissions.body).permissions);
      const siteAdmin = rec(held.ADMINISTER).havePermission === true;

      const lines = [
        `Connected as ${str(me.displayName) || access.accountId} (${access.accountId})` +
          (access.siteUrl ? ` on ${access.siteUrl}` : ''),
        siteAdmin
          ? 'Administer Jira: yes — site configuration (custom fields and their options, work ' +
            'types, workflows, schemes) and Plans are open to this account.'
          : 'Administer Jira: no — site configuration and Plans need it; a Jira admin has to ' +
            'make those changes.',
      ];

      if (!spaces.ok) {
        lines.push(`Spaces this account administers: could not be listed (${spaces.error})`);
      } else {
        const page = rec(spaces.body);
        const listed = records(spaces.body);
        const total = typeof page.total === 'number' ? page.total : listed.length;
        if (listed.length === 0) {
          lines.push('Spaces this account administers: none.');
        } else {
          lines.push(
            `Spaces this account administers (${total}` +
              (total > listed.length ? `, first ${listed.length} shown` : '') +
              '):',
            ...listed.map((space) => `  • ${str(space.key)} — ${str(space.name)}`)
          );
        }
      }

      return textResult(lines.join('\n'));
    }
  );
}
