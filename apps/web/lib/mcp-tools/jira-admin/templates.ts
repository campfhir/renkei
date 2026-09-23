/**
 * Space templates: save a space's configuration under a name, list and
 * delete them, and check a space against one.
 *
 * A template is Renkei's own record (migration 124, lib/jira-admin/
 * space-templates.ts) — saving or deleting one changes nothing in Jira, so
 * these need no review page. They are still Act tools, so org read-only
 * mode hides them with every other write.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, textResult } from './client';
import {
  COPYABLE_TYPES,
  SCHEME_KEYS,
  SCHEME_LABELS,
  readSpaceConfiguration,
} from '@/lib/jira-admin/space-config';
import {
  TEMPLATE_NAME_MAX,
  componentsText,
  deleteSpaceTemplate,
  documentFromSpace,
  findSpaceTemplate,
  listSpaceTemplates,
  saveSpaceTemplate,
  templateDifferences,
  type SpaceTemplate,
  type TemplateDocument,
} from '@/lib/jira-admin/space-templates';

/** A template's contents, one line per scheme and role. */
export function templateLines(document: TemplateDocument): string[] {
  const lines = [`Type: ${document.projectTypeKey}`];
  for (const key of SCHEME_KEYS) {
    const scheme = document.schemes[key];
    const none =
      key === 'fieldConfigurationScheme'
        ? 'the system default'
        : key === 'issueSecurityScheme'
          ? 'none'
          : '?';
    lines.push(
      `${SCHEME_LABELS[key].charAt(0).toUpperCase()}${SCHEME_LABELS[key].slice(1)}: ` +
        (scheme ? `“${scheme.name}” (id ${scheme.id})` : none)
    );
  }
  if (document.assigneeType) lines.push(`Default assignee: ${document.assigneeType}`);
  if (document.category) lines.push(`Category: ${document.category.name}`);
  const roles = document.roles.filter((role) => role.groups.length > 0);
  lines.push(
    roles.length === 0
      ? 'Roles: no groups'
      : `Roles: ${roles
          .map((role) => `${role.roleName} — ${role.groups.map((group) => group.name).join(', ')}`)
          .join('; ')}`
  );
  lines.push(`Components: ${componentsText(document)}`);
  return lines;
}

function otherSite(template: SpaceTemplate): string {
  return (
    `The template “${template.name}” was saved from another Jira site` +
    (template.siteUrl ? ` (${template.siteUrl})` : '') +
    '; its schemes do not exist on this one.'
  );
}

export async function registerTemplateTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_save_space_template',
    {
      title: 'Jira Admin · Act — Save a space as a template',
      description:
        'Save how a company-managed space is configured — its type, the seven schemes it runs ' +
        'on (work types, screens, workflows, field configuration, permissions, notifications, ' +
        'issue security), default assignee, category, the groups in each role and its ' +
        'components — as a named template, for creating new spaces the same way ' +
        '(jira_admin_propose_space) and checking spaces against it ' +
        '(jira_admin_compare_space_to_template). People in roles and component leads are not ' +
        'saved. Templates are shared by everyone in the organization who uses Jira ' +
        'Administration. Changes nothing in Jira.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        space: z.string().min(1).describe('The space (project) key to save, e.g. OPS'),
        name: z.string().min(1).max(TEMPLATE_NAME_MAX).describe('The template’s name'),
        description: z.string().max(1000).describe('What spaces this template is for').optional(),
        overwrite: z
          .boolean()
          .describe('Replace an existing template of the same name (default false)')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const spaceRef = typeof args.space === 'string' ? args.space.trim().toUpperCase() : '';
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!spaceRef || !name) return errText('space and name are required');

      const read = await readSpaceConfiguration(context, access, spaceRef);
      if (!read.ok) return errText(read.reason);
      const space = read.space;
      if (!COPYABLE_TYPES.has(space.projectTypeKey)) {
        return errText(
          `${space.key} is a ${space.projectTypeKey} space. Templates cover company-managed ` +
            'software and business spaces for now.'
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was saved.');
      const document = documentFromSpace(space);
      const saved = await saveSpaceTemplate(dbResult.val, {
        tenantId: context.tenantId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        name,
        description: typeof args.description === 'string' ? args.description : undefined,
        sourceSpaceKey: space.key,
        document,
        subject: context.subject,
        overwrite: args.overwrite === true,
      });
      if (!saved.ok) {
        return errText(
          saved.reason === 'exists'
            ? `A template named “${name}” already exists. Pass overwrite: true to replace it, or pick another name.`
            : 'The template could not be read back after saving.'
        );
      }
      const people = space.roles.reduce((total, role) => total + role.users.length, 0);
      const led = space.components.filter(
        (component) => component.assigneeType === 'COMPONENT_LEAD'
      );
      return textResult(
        [
          `${saved.replaced ? 'Replaced' : 'Saved'} the template “${saved.template.name}” from ${space.key} — nothing changed in Jira.`,
          '',
          ...templateLines(document),
          ...(people > 0
            ? [
                '',
                `${people} ${people === 1 ? 'person' : 'people'} in ${space.key}’s roles ${people === 1 ? 'was' : 'were'} not saved: a template ` +
                  'keeps groups, and the people for a new space are named when it is proposed.',
              ]
            : []),
          ...(led.length > 0
            ? [
                '',
                `${led.map((component) => component.name).join(', ')} ${led.length === 1 ? 'sends its' : 'send their'} issues to a component lead in ` +
                  `${space.key}; in a new space ${led.length === 1 ? 'it goes' : 'they go'} to the space’s default assignee instead, since a template ` +
                  'holds no people.',
              ]
            : []),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'jira_admin_list_space_templates',
    {
      title: 'Jira Admin · Read — List space templates',
      description:
        'The organization’s saved space templates, or one in full: its schemes, default ' +
        'assignee, category and the groups in each role. Templates saved from another Jira site ' +
        'are marked, since they cannot be used on this one.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        template: z
          .string()
          .describe('One template’s name or id, for its full contents')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const reference = typeof args.template === 'string' ? args.template.trim() : '';
      if (reference) {
        const template = await findSpaceTemplate(
          dbResult.val,
          context.tenantId,
          access.cloudId,
          reference
        );
        if (!template) return errText(`No template is named “${reference}”.`);
        return textResult(
          [
            `${template.name}${template.cloudId === access.cloudId ? '' : ' — from another Jira site'}`,
            ...(template.description ? [template.description] : []),
            `Saved from ${template.sourceSpaceKey ?? 'a space'}, last on ${template.updatedAt.toISOString().slice(0, 10)}.`,
            '',
            ...templateLines(template.document),
          ].join('\n')
        );
      }

      const templates = await listSpaceTemplates(dbResult.val, context.tenantId);
      if (templates.length === 0) {
        return textResult(
          'No space templates yet. Save one from a space that is set up the way you want with ' +
            'jira_admin_save_space_template.'
        );
      }
      return textResult(
        templates
          .map(
            (template) =>
              `• ${template.name} — ${template.document.projectTypeKey}, from ${template.sourceSpaceKey ?? 'a space'}` +
              (template.description ? ` — ${template.description}` : '') +
              (template.cloudId === access.cloudId ? '' : ' — another Jira site, not usable here')
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'jira_admin_delete_space_template',
    {
      title: 'Jira Admin · Act — Delete a space template',
      description:
        'Delete a saved space template. Spaces already created from it are not affected, and ' +
        'nothing changes in Jira.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        template: z.string().min(1).describe('The template’s name or id'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const reference = typeof args.template === 'string' ? args.template.trim() : '';
      const template = await findSpaceTemplate(
        dbResult.val,
        context.tenantId,
        access.cloudId,
        reference
      );
      if (!template) return errText(`No template is named “${reference}”.`);
      const deleted = await deleteSpaceTemplate(dbResult.val, context.tenantId, template.id);
      return deleted
        ? textResult(`Deleted the template “${template.name}”. Nothing changed in Jira.`)
        : errText(`The template “${template.name}” could not be deleted.`);
    }
  );

  server.registerTool(
    'jira_admin_compare_space_to_template',
    {
      title: 'Jira Admin · Read — Compare a space to a template',
      description:
        'Check a space against a saved template: which schemes, default assignee, category, ' +
        'role groups and components differ. Reports differences only; nothing is changed. ' +
        'Useful for finding spaces that have drifted from how they were set up.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        space: z.string().min(1).describe('The space (project) key, e.g. OPS'),
        template: z.string().min(1).describe('The template’s name or id'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const reference = typeof args.template === 'string' ? args.template.trim() : '';
      const template = await findSpaceTemplate(
        dbResult.val,
        context.tenantId,
        access.cloudId,
        reference
      );
      if (!template) return errText(`No template is named “${reference}”.`);
      if (template.cloudId !== access.cloudId) return errText(otherSite(template));

      const spaceRef = typeof args.space === 'string' ? args.space.trim().toUpperCase() : '';
      const read = await readSpaceConfiguration(context, access, spaceRef);
      if (!read.ok) return errText(read.reason);

      const differences = templateDifferences(template.document, read.space);
      return textResult(
        differences.length === 0
          ? `${read.space.key} matches the template “${template.name}”: same type, schemes, ` +
              'default assignee, category, role groups' +
              (template.document.components === null ? '.' : ' and components.')
          : [
              `${read.space.key} differs from the template “${template.name}” in ${differences.length} way${differences.length === 1 ? '' : 's'}:`,
              ...differences.map((difference) => `• ${difference}`),
            ].join('\n')
      );
    }
  );
}
