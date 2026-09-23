/**
 * jira_admin_propose_space — a new company-managed space, from a saved
 * template or "like" an existing space, proposed as a change request the
 * person applies from Renkei's review page. Nothing is created in Jira
 * here: this reads what it needs, checks everything that could be checked
 * now (the key and name are free, the lead and every named member exist,
 * a template's schemes are still there), and stores the exact operations.
 *
 * "Like OPS" reads OPS live and copies what a template would keep — its
 * schemes, type, default assignee, category, role groups and components —
 * but not the people in its roles: who works in the new space is named in
 * `members`. More components, and the space's first versions, can be named
 * too; those two are manage:jira-project writes, so the result says when
 * the connection cannot apply them yet.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, jiraAdminGet, rec, records, str, type JiraAdminAccess } from './client';
import { reviewPrefix } from './review-link';
import { ATLASSIAN_ADMIN_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import {
  CHANGE_REQUEST_TTL_HOURS,
  cancelChangeRequest,
  createChangeRequest,
} from '@/lib/jira-admin/change-requests';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import { resolveGroup, resolvePerson, type Group, type Person } from '@/lib/jira-admin/people';
import {
  COPYABLE_TYPES,
  missingSchemes,
  readSpaceConfiguration,
  workflowSchemeUsage,
} from '@/lib/jira-admin/space-config';
import {
  CREATE_SPACE_KIND,
  DATE_PATTERN,
  SPACE_KEY_PATTERN,
  createSpaceScopes,
  planSpaceCreation,
  spaceTitle,
  type CreateSpacePayload,
  type SpaceBase,
  type VersionPlan,
} from '@/lib/jira-admin/space-creation';
import { documentFromSpace, findSpaceTemplate } from '@/lib/jira-admin/space-templates';

const MAX_MEMBERS_PER_ROLE = 50;

/** The connect-picker boxes that carry these scopes, for "reconnect with … ticked". */
function scopeBoxes(scopes: string[]): string {
  return ATLASSIAN_ADMIN_SCOPE_OPTIONS.filter((option) =>
    option.scopes.some((scope) => scopes.includes(scope))
  )
    .map((option) => `“${option.label}”`)
    .join(' and ');
}

/** Every project role on the site, by id and name — for roles a template does not mention. */
async function siteRoles(
  context: MCPToolContext,
  access: JiraAdminAccess
): Promise<{ id: string; name: string }[] | string> {
  const result = await jiraAdminGet(context, access, '/rest/api/3/role');
  if (!result.ok) return result.error;
  return records(result.body)
    .map((role) => ({ id: str(role.id), name: str(role.name) }))
    .filter((role) => role.id && role.name);
}

export async function registerProposeSpaceTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_propose_space',
    {
      title: 'Jira Admin · Act — Propose a new space',
      description:
        'Propose a new company-managed Jira space (project), built from a saved template ' +
        '(jira_admin_list_space_templates) or like an existing space: it runs on the same ' +
        'schemes, with the same type, default assignee, category and role groups, plus the ' +
        'people you name for each role. Nothing is created in Jira: this saves a change request, ' +
        'and the user applies it from the Renkei review page linked in the result (it expires ' +
        `in ${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link. The new space shares ` +
        'those schemes rather than copying them, and the review page says so. People in the ' +
        'source space’s roles are not copied — name them in members. The template’s or source ' +
        'space’s components come along; name more in components, and the first versions in ' +
        'versions.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        key: z
          .string()
          .min(2)
          .max(10)
          .describe(
            'The new space’s key: an uppercase letter, then letters, digits or _, e.g. FIN'
          ),
        name: z.string().min(1).max(80).describe('The new space’s name'),
        lead: z.string().min(1).describe('The space lead — an email address or account id'),
        template: z
          .string()
          .describe('A saved template’s name or id to build from — or pass likeSpace')
          .optional(),
        likeSpace: z
          .string()
          .describe('An existing space’s key to build like — or pass template')
          .optional(),
        description: z.string().max(1000).describe('The new space’s description').optional(),
        members: z
          .array(
            z.object({
              role: z.string().min(1).describe('A project role’s name, e.g. Administrators'),
              users: z
                .array(z.string().min(1))
                .max(MAX_MEMBERS_PER_ROLE)
                .describe('Email addresses or account ids')
                .optional(),
              groups: z
                .array(z.string().min(1))
                .max(MAX_MEMBERS_PER_ROLE)
                .describe('Group names')
                .optional(),
            })
          )
          .max(20)
          .describe('People and groups to add to each role, beyond the template’s groups')
          .optional(),
        components: z
          .array(z.string().min(1).max(255))
          .max(50)
          .describe('Components to add beyond the template’s or source space’s, by name')
          .optional(),
        versions: z
          .array(
            z.object({
              name: z.string().min(1).max(255).describe('e.g. 2026.1'),
              startDate: z.string().regex(DATE_PATTERN).describe('YYYY-MM-DD').optional(),
              releaseDate: z.string().regex(DATE_PATTERN).describe('YYYY-MM-DD').optional(),
            })
          )
          .max(20)
          .describe('Versions to create in the new space')
          .optional(),
        reason: z
          .string()
          .max(1000)
          .describe('Why — shown to the user on the review page')
          .optional(),
        replaces: z
          .string()
          .describe(
            'The id of a pending change request of this user’s that this one supersedes; it is ' +
              'cancelled once this one is saved'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

      const key = text(args.key).toUpperCase();
      const name = text(args.name);
      const templateRef = text(args.template);
      const likeRef = text(args.likeSpace).toUpperCase();
      if (!SPACE_KEY_PATTERN.test(key)) {
        return errText(
          `“${key}” is not a space key Jira accepts: an uppercase letter, then uppercase ` +
            'letters, digits or _, 2 to 10 characters in all.'
        );
      }
      if (!name) return errText('name is required');
      if (Boolean(templateRef) === Boolean(likeRef)) {
        return errText(
          'Pass exactly one of template (a saved template) or likeSpace (a space key).'
        );
      }
      const versions: VersionPlan[] = [];
      for (const entry of Array.isArray(args.versions) ? args.versions.map(rec) : []) {
        const version = {
          name: text(entry.name),
          startDate: text(entry.startDate) || null,
          releaseDate: text(entry.releaseDate) || null,
        };
        const badDate = [version.startDate, version.releaseDate].find(
          (date) => date !== null && !DATE_PATTERN.test(date)
        );
        if (!version.name) return errText('Each version needs a name.');
        if (badDate)
          return errText(`Version ${version.name}: “${badDate}” is not a YYYY-MM-DD date.`);
        if (version.startDate && version.releaseDate && version.startDate > version.releaseDate) {
          return errText(`Version ${version.name} would be released before it starts.`);
        }
        versions.push(version);
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
      const db = dbResult.val;

      // The base: a template (checked still intact) or a live space.
      let base: SpaceBase;
      let source: CreateSpacePayload['source'];
      const notes: string[] = [];
      if (templateRef) {
        const template = await findSpaceTemplate(db, context.tenantId, access.cloudId, templateRef);
        if (!template) {
          return errText(
            `No template is named “${templateRef}”. jira_admin_list_space_templates lists them.`
          );
        }
        if (template.cloudId !== access.cloudId) {
          return errText(
            `The template “${template.name}” was saved from another Jira site` +
              (template.siteUrl ? ` (${template.siteUrl})` : '') +
              '; its schemes do not exist on this one.'
          );
        }
        const gone = await missingSchemes(context, access, template.document.schemes);
        if (gone.length > 0) {
          return errText(
            `The template “${template.name}” names ${gone.join('; ')}. Save it again from a ` +
              'space that is set up the way you want.'
          );
        }
        base = template.document;
        source = { kind: 'template', id: template.id, name: template.name };
        if (template.document.components === null) {
          notes.push(
            `The template “${template.name}” was saved before Renkei kept components, so it ` +
              'brings none; save it again with overwrite to include them.'
          );
        }
      } else {
        const read = await readSpaceConfiguration(context, access, likeRef);
        if (!read.ok) return errText(read.reason);
        base = documentFromSpace(read.space);
        source = { kind: 'space', key: read.space.key };
        const people = read.space.roles.reduce((total, role) => total + role.users.length, 0);
        if (people > 0) {
          notes.push(
            `The ${people} ${people === 1 ? 'person' : 'people'} in ${read.space.key}’s roles ` +
              `${people === 1 ? 'is' : 'are'} not copied; name anyone who should be in the new ` +
              'space in members.'
          );
        }
      }
      if (!COPYABLE_TYPES.has(base.projectTypeKey)) {
        return errText(
          `That is a ${base.projectTypeKey} space. New spaces from a template or like another ` +
            'cover company-managed software and business spaces for now.'
        );
      }

      // The key and the name must be free.
      const keyCheck = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/projectvalidate/key?key=${encodeURIComponent(key)}`
      );
      if (!keyCheck.ok) return errText(`Checking the key ${key}: ${keyCheck.error}`);
      const keyProblem = str(rec(rec(keyCheck.body).errors).projectKey);
      if (keyProblem) return errText(`${key} cannot be used: ${keyProblem}`);
      const sameName = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/search?maxResults=50&query=${encodeURIComponent(name)}`
      );
      if (!sameName.ok) return errText(`Checking the name: ${sameName.error}`);
      const clash = records(sameName.body).find(
        (project) => str(project.name).trim().toLowerCase() === name.toLowerCase()
      );
      if (clash) return errText(`A space is already named “${name}” (${str(clash.key)}).`);

      // The lead, and everyone named for a role.
      const lead = await resolvePerson(context, access, text(args.lead));
      if (!lead.ok) return errText(`Lead: ${lead.reason}`);

      const members: { roleId: string; roleName: string; groups: Group[]; users: Person[] }[] = [];
      const requested = Array.isArray(args.members) ? args.members.map(rec) : [];
      let roles: { id: string; name: string }[] | null = null;
      for (const entry of requested) {
        const roleName = text(entry.role);
        let role = base.roles.find(
          (candidate) => candidate.roleName.toLowerCase() === roleName.toLowerCase()
        );
        if (!role) {
          if (!roles) {
            const listed = await siteRoles(context, access);
            if (typeof listed === 'string') return errText(`Reading the site’s roles: ${listed}`);
            roles = listed;
          }
          const found = roles.find(
            (candidate) => candidate.name.toLowerCase() === roleName.toLowerCase()
          );
          if (!found) {
            return errText(
              `No project role is named “${roleName}”. Roles: ${roles.map((candidate) => candidate.name).join(', ')}.`
            );
          }
          role = { roleId: found.id, roleName: found.name, groups: [] };
        }
        const users: Person[] = [];
        for (const user of Array.isArray(entry.users) ? entry.users.map(text) : []) {
          const person = await resolvePerson(context, access, user);
          if (!person.ok) return errText(`${role.roleName}: ${person.reason}`);
          users.push(person.value);
        }
        const groups: Group[] = [];
        for (const groupName of Array.isArray(entry.groups) ? entry.groups.map(text) : []) {
          const group = await resolveGroup(context, access, groupName);
          if (!group.ok) return errText(`${role.roleName}: ${group.reason}`);
          groups.push(group.value);
        }
        members.push({ roleId: role.roleId, roleName: role.roleName, groups, users });
      }

      const payload: CreateSpacePayload = {
        source,
        workflowUsage: await workflowSchemeUsage(context, access, base.schemes.workflowScheme.id),
        operations: planSpaceCreation({
          key,
          name,
          description: text(args.description) || null,
          lead: lead.value,
          base,
          members,
          components: Array.isArray(args.components) ? args.components.map(text) : [],
          versions,
        }),
      };
      // Components and versions are manage:jira-project writes; say now,
      // not at apply time, when this connection cannot make them.
      const unheld = createSpaceScopes(payload).filter(
        (scope) => !(context.jiraAdminScopes ?? []).includes(scope)
      );
      if (unheld.length > 0) {
        notes.push(
          `Applying this needs ${scopeBoxes(unheld)}, which your Jira Administration ` +
            'connection does not include: reconnect it with that ticked before applying (if it ' +
            'is not offered, an organization admin allows it under Connector setup first).'
        );
      }
      const reason = text(args.reason);
      const change = await createChangeRequest(db, {
        tenantId: context.tenantId,
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        kind: CREATE_SPACE_KIND,
        title: spaceTitle(payload),
        reason: reason || undefined,
        payload,
      });

      const replaces = text(args.replaces);
      if (replaces) {
        const cancelled = await cancelChangeRequest(
          db,
          context.tenantId,
          context.subject,
          replaces
        );
        notes.push(
          cancelled
            ? `Cancelled the request it replaces (${replaces}).`
            : `Did not cancel ${replaces}: it is not a pending request of this user’s.`
        );
      }

      const link = `${await reviewPrefix(context)}${change.id}`;
      const { operations, reach } = describeChange(change);
      const lines = [
        'Proposed — nothing has been created in Jira yet.',
        '',
        ...operationLines(operations),
        ...(reach ? ['', `Where: ${reach}`] : []),
        ...(notes.length > 0 ? ['', ...notes] : []),
        '',
        `Review and apply: ${link}`,
        `Change request ${change.id}; it expires in ${CHANGE_REQUEST_TTL_HOURS} hours. Only the ` +
          'user can apply it, from that page while signed in to Renkei — share the link.',
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        _meta: actMeta({ url: link }),
      };
    }
  );
}
