/**
 * The entra_ read tools: what the connection acts as, app registrations
 * and enterprise applications with their app roles and assignments, and
 * the people and groups a role can be handed to.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { EntraAuth } from './entra-auth';
import {
  entraGet,
  errText,
  odataString,
  rec,
  searchClause,
  str,
  strings,
  textResult,
  values,
  EVENTUAL,
} from './client';
import {
  APPLICATION_SELECT,
  SERVICE_PRINCIPAL_SELECT,
  appRolesOf,
  describeRole,
  findApplication,
  findServicePrincipal,
  listAssignments,
  roleLabel,
  searchGroups,
  searchUsers,
  servicePrincipalForAppId,
} from './resolve';

const MAX_LISTED = 50;

const limitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_LISTED)
  .optional()
  .describe(`How many to list (default 25, at most ${MAX_LISTED}).`);

export const applicationRefField = z
  .string()
  .min(1)
  .describe(
    'The app registration: its object id, its application (client) id, or its exact display name.'
  );

export const servicePrincipalRefField = z
  .string()
  .min(1)
  .describe(
    'The enterprise application: its object id, its application (client) id, or its exact ' +
      'display name.'
  );

function redirectLines(app: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const web = strings(rec(app.web).redirectUris);
  const spa = strings(rec(app.spa).redirectUris);
  const publicClient = strings(rec(app.publicClient).redirectUris);
  if (web.length > 0) lines.push(`Web redirect URIs: ${web.join(', ')}`);
  if (spa.length > 0) lines.push(`Single-page app redirect URIs: ${spa.join(', ')}`);
  if (publicClient.length > 0) {
    lines.push(`Mobile/desktop redirect URIs: ${publicClient.join(', ')}`);
  }
  if (lines.length === 0) lines.push('Redirect URIs: none');
  return lines;
}

/** The lines every application read shares. */
export function describeApplication(app: Record<string, unknown>): string[] {
  const roles = appRolesOf(app);
  const identifierUris = strings(app.identifierUris);
  return [
    `${str(app.displayName)} — app registration`,
    `Object id: ${str(app.id)}`,
    `Application (client) id: ${str(app.appId)}`,
    `Sign-in audience: ${str(app.signInAudience) || 'unknown'}`,
    ...(str(app.description) ? [`Description: ${str(app.description)}`] : []),
    `Created: ${str(app.createdDateTime) || 'unknown'}`,
    `Identifier URIs: ${identifierUris.length > 0 ? identifierUris.join(', ') : 'none'}`,
    ...redirectLines(app),
    roles.length === 0
      ? 'App roles: none defined (assignments use the default access role).'
      : `App roles (${roles.length}):`,
    ...roles.map((role) => `  • ${describeRole(role)}`),
  ];
}

export async function registerReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: EntraAuth
): Promise<void> {
  server.registerTool(
    'entra_check_access',
    {
      title: 'Entra Developer · Read — What can this connection do?',
      description:
        'Who the Entra Developer connection acts as, which delegated permissions its token ' +
        'carries, and whether Entra lets it read applications and enterprise applications. ' +
        'Call this first when a provisioning call is refused: Entra restricts who may create ' +
        'applications, and changing one needs ownership of it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const [me, applications, servicePrincipals] = await Promise.all([
        entraGet(context, access, '/me?$select=id,displayName,userPrincipalName'),
        entraGet(context, access, '/applications?$top=1&$select=id'),
        entraGet(context, access, '/servicePrincipals?$top=1&$select=id'),
      ]);
      if (!me.ok) return errText(me.error);

      const scopes = context.entraDeveloperScopes ?? [];
      const held = (scope: string) => scopes.includes(scope);
      const lines = [
        `Connected as ${str(me.body.displayName) || access.upn} (${str(me.body.userPrincipalName) || access.upn})` +
          (access.tenantId ? ` in directory ${access.tenantId}` : ''),
        `Permissions on this connection: ${scopes.length > 0 ? scopes.join(', ') : 'unknown (older grant)'}`,
        applications.ok
          ? 'Read app registrations: yes.'
          : `Read app registrations: no — ${applications.error}`,
        servicePrincipals.ok
          ? 'Read enterprise applications: yes.'
          : `Read enterprise applications: no — ${servicePrincipals.error}`,
        held('Application.ReadWrite.All')
          ? 'Create and change applications: the token allows it; Entra decides per call ' +
            '(creation may be restricted to admins, and changing an application needs to own it).'
          : 'Create and change applications: not on this connection (Application.ReadWrite.All).',
        held('AppRoleAssignment.ReadWrite.All')
          ? 'Assign app roles: the token allows it.'
          : 'Assign app roles: not on this connection (AppRoleAssignment.ReadWrite.All).',
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'entra_list_applications',
    {
      title: 'Entra Developer · Read — List app registrations',
      description:
        'App registrations in the directory, newest first, optionally narrowed to names ' +
        'containing a term. Each line carries the object id and application (client) id ' +
        'other tools take.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Part of a display name to match; omit for the newest registrations.'),
        limit: limitField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const limit = args.limit ?? 25;
      const term = (args.query ?? '').replace(/"/g, '').trim();
      const path = term
        ? `/applications?$search=${encodeURIComponent(searchClause('displayName', term))}&$count=true&$top=${limit}&$select=id,appId,displayName,createdDateTime,signInAudience,appRoles`
        : `/applications?$orderby=createdDateTime desc&$top=${limit}&$select=id,appId,displayName,createdDateTime,signInAudience,appRoles`;
      const result = await entraGet(context, access, path, EVENTUAL);
      if (!result.ok) return errText(result.error);
      const apps = values(result.body);
      if (apps.length === 0) {
        return textResult(
          term ? `No app registration name contains "${term}".` : 'No app registrations.'
        );
      }
      const lines = apps.map((app) => {
        const roles = appRolesOf(app).length;
        return (
          `• ${str(app.displayName)} — id ${str(app.id)}, appId ${str(app.appId)}, ` +
          `${str(app.signInAudience) || 'audience unknown'}, ${roles} app role${roles === 1 ? '' : 's'}, ` +
          `created ${str(app.createdDateTime).slice(0, 10) || 'unknown'}`
        );
      });
      const more = result.body['@odata.nextLink'] ? ' (more exist; narrow with query)' : '';
      return textResult(
        [`${apps.length} app registration${apps.length === 1 ? '' : 's'}${more}:`, ...lines].join(
          '\n'
        )
      );
    }
  );

  server.registerTool(
    'entra_get_application',
    {
      title: 'Entra Developer · Read — Get an app registration',
      description:
        'An app registration in full: ids, sign-in audience, identifier URIs, redirect URIs ' +
        'per platform, and its app roles — plus whether it has an enterprise application ' +
        '(service principal) in this directory, which is what roles get assigned on.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ application: applicationRefField }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const sp = await servicePrincipalForAppId(context, access, str(app.appId));
      const lines = describeApplication(app);
      if (!sp.ok) {
        lines.push(`Enterprise application: could not be checked (${sp.error})`);
      } else if (sp.value) {
        lines.push(
          `Enterprise application: yes — object id ${str(sp.value.id)} ` +
            `(entra_get_enterprise_application shows its assignments).`
        );
      } else {
        lines.push(
          'Enterprise application: none yet — entra_create_enterprise_application_preview ' +
            'creates one, which is what app roles are assigned on.'
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'entra_list_enterprise_applications',
    {
      title: 'Entra Developer · Read — List enterprise applications',
      description:
        'Enterprise applications (service principals) in the directory — by default this ' +
        "directory's own, optionally narrowed to names containing a term, or widened to " +
        'every application including Microsoft’s and other tenants’.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().optional().describe('Part of a display name to match.'),
        ownOnly: z
          .boolean()
          .optional()
          .describe(
            'Only applications registered in this directory (default true). False also lists ' +
              'multi-tenant and Microsoft applications.'
          ),
        limit: limitField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const limit = args.limit ?? 25;
      const term = (args.query ?? '').replace(/"/g, '').trim();
      const ownOnly = args.ownOnly !== false;
      const filters = ["servicePrincipalType eq 'Application'"];
      if (ownOnly && access.tenantId) {
        filters.push(`appOwnerOrganizationId eq ${access.tenantId}`);
      }
      const select =
        '$select=id,appId,displayName,accountEnabled,appOwnerOrganizationId,appRoleAssignmentRequired,appRoles';
      const path =
        `/servicePrincipals?$filter=${encodeURIComponent(filters.join(' and '))}` +
        (term ? `&$search=${encodeURIComponent(searchClause('displayName', term))}` : '') +
        `&$count=true&$top=${limit}&${select}`;
      const result = await entraGet(context, access, path, EVENTUAL);
      if (!result.ok) return errText(result.error);
      const sps = values(result.body);
      if (sps.length === 0) {
        return textResult(
          term
            ? `No enterprise application name contains "${term}".`
            : 'No enterprise applications.'
        );
      }
      const lines = sps.map((sp) => {
        const roles = appRolesOf(sp).length;
        return (
          `• ${str(sp.displayName)} — id ${str(sp.id)}, appId ${str(sp.appId)}, ` +
          `${sp.accountEnabled === false ? 'disabled' : 'enabled'}, ` +
          `${roles} app role${roles === 1 ? '' : 's'}` +
          (sp.appRoleAssignmentRequired === true ? ', assignment required' : '')
        );
      });
      const more = result.body['@odata.nextLink'] ? ' (more exist; narrow with query)' : '';
      return textResult(
        [
          `${sps.length} enterprise application${sps.length === 1 ? '' : 's'}${more}:`,
          ...lines,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'entra_get_enterprise_application',
    {
      title: 'Entra Developer · Read — Get an enterprise application',
      description:
        'An enterprise application (service principal) in full: ids, whether sign-in and ' +
        'assignment are required, its app roles, and every user, group and application ' +
        'assigned to each role.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ enterpriseApplication: servicePrincipalRefField }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findServicePrincipal(context, access, args.enterpriseApplication);
      if (!found.ok) return errText(found.error);
      const sp = found.value;
      const roles = appRolesOf(sp);
      const assigned = await listAssignments(context, access, str(sp.id));
      const lines = [
        `${str(sp.displayName)} — enterprise application`,
        `Object id: ${str(sp.id)}`,
        `Application (client) id: ${str(sp.appId)}`,
        `Enabled for sign-in: ${sp.accountEnabled === false ? 'no' : 'yes'}`,
        `Assignment required: ${sp.appRoleAssignmentRequired === true ? 'yes' : 'no'}`,
        access.tenantId &&
        str(sp.appOwnerOrganizationId) &&
        str(sp.appOwnerOrganizationId) !== access.tenantId
          ? `Registered in another directory (${str(sp.appOwnerOrganizationId)}); its roles are defined there.`
          : '',
        roles.length === 0
          ? 'App roles: none defined (assignments use the default access role).'
          : `App roles (${roles.length}):`,
        ...roles.map((role) => `  • ${describeRole(role)}`),
      ].filter(Boolean);
      if (!assigned.ok) {
        lines.push(`Assignments: could not be listed (${assigned.error})`);
      } else if (assigned.value.assignments.length === 0) {
        lines.push('Assignments: none.');
      } else {
        const { assignments, truncated } = assigned.value;
        lines.push(`Assignments (${assignments.length}${truncated ? ', first shown' : ''}):`);
        for (const a of assignments) {
          lines.push(
            `  • ${a.principalDisplayName || a.principalId} (${a.principalType.toLowerCase()}) → ` +
              `${roleLabel(roles, a.appRoleId)} — assignment id ${a.id}`
          );
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'entra_search_users',
    {
      title: 'Entra Developer · Read — Find people',
      description:
        'People in the directory whose name or address contains a term — to pick who gets an ' +
        'app role. Returns object ids the assign tools take (they also take an address or an ' +
        'exact name).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Part of a name, address or user principal name.'),
        limit: limitField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await searchUsers(context, access, args.query, args.limit ?? 25);
      if (!found.ok) return errText(found.error);
      if (found.value.length === 0) return textResult(`No one matches "${args.query}".`);
      return textResult(
        [
          `${found.value.length} match${found.value.length === 1 ? '' : 'es'}:`,
          ...found.value.map(
            (u) =>
              `• ${str(u.displayName)} — ${str(u.mail) || str(u.userPrincipalName)}` +
              (str(u.jobTitle) ? `, ${str(u.jobTitle)}` : '') +
              (str(u.department) ? ` (${str(u.department)})` : '') +
              ` — id ${str(u.id)}`
          ),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'entra_search_groups',
    {
      title: 'Entra Developer · Read — Find groups',
      description:
        'Groups in the directory whose name or mail contains a term — to pick which get an ' +
        'app role. Returns object ids the assign tools take (they also take an exact name).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Part of a group name or mail address.'),
        limit: limitField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await searchGroups(context, access, args.query, args.limit ?? 25);
      if (!found.ok) return errText(found.error);
      if (found.value.length === 0) return textResult(`No group matches "${args.query}".`);
      return textResult(
        [
          `${found.value.length} match${found.value.length === 1 ? '' : 'es'}:`,
          ...found.value.map((g) => {
            const kinds = [
              g.securityEnabled === true ? 'security' : '',
              strings(g.groupTypes).includes('Unified') ? 'Microsoft 365' : '',
            ].filter(Boolean);
            return (
              `• ${str(g.displayName)}${str(g.mail) ? ` — ${str(g.mail)}` : ''}` +
              ` (${kinds.length > 0 ? kinds.join(', ') : 'group'})` +
              (str(g.description) ? ` — ${str(g.description)}` : '') +
              ` — id ${str(g.id)}`
            );
          }),
        ].join('\n')
      );
    }
  );
}

// Referenced by the provisioning tools' selects; kept here so the read
// shape and the write shape cannot drift apart.
export { APPLICATION_SELECT, SERVICE_PRINCIPAL_SELECT, odataString };
