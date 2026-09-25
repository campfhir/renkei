/**
 * The entra_ assignment tools: give users and groups an app role on an
 * enterprise application, or take one away. Preview + confirm on the
 * directory_action_preview card, like every other write here.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  DIRECTORY_ACTION_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import type { EntraAuth } from './entra-auth';
import { entraRequest, errText, str, textResult } from './client';
import {
  appRolesOf,
  findAppRole,
  findPrincipal,
  findServicePrincipal,
  listAssignments,
  roleLabel,
  type Principal,
} from './resolve';
import { servicePrincipalRefField } from './applications';
import { previewResult } from './provision';

const MAX_ASSIGNEES = 25;

const assigneesField = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_ASSIGNEES)
  .describe(
    'Who gets the role: each a user or group object id, a user’s address (UPN or mail), or ' +
      `an exact user or group display name. At most ${MAX_ASSIGNEES} per call.`
  );

const roleField = z
  .string()
  .optional()
  .describe(
    'The app role: its id, claim value or display name. Omit only for an application that ' +
      'defines no roles (its default access).'
  );

function principalLine(principal: Principal): string {
  // An address says "user" and "security group" says "group" on their
  // own; the type word only fills in when there is no detail to carry it.
  return `${principal.displayName} (${principal.detail || principal.type.toLowerCase()})`;
}

/** Every assignee resolved, or the first refusal. */
async function resolveAssignees(
  context: MCPToolContext,
  access: Parameters<typeof findPrincipal>[1],
  references: string[]
): Promise<{ ok: true; principals: Principal[] } | { ok: false; error: string }> {
  const principals: Principal[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const found = await findPrincipal(context, access, reference);
    if (!found.ok) return { ok: false, error: found.error };
    if (seen.has(found.value.id)) continue;
    seen.add(found.value.id);
    principals.push(found.value);
  }
  return { ok: true, principals };
}

export async function registerAssignmentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: EntraAuth
): Promise<void> {
  // -------------------------------------------------------------------
  // Assign.
  // -------------------------------------------------------------------

  const assignSchema = z.object({
    enterpriseApplication: servicePrincipalRefField,
    appRole: roleField,
    assignees: assigneesField,
  });

  server.registerTool(
    'entra_assign_app_role_preview',
    {
      title: 'Entra Developer · Act — Preview assigning an app role',
      description:
        'Show the user a card to confirm or cancel giving users and groups an app role on an ' +
        'enterprise application. Assignees can be named by id, address or exact name; ' +
        'entra_search_users and entra_search_groups find them. Anyone who already holds the ' +
        'role is skipped. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: assignSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findServicePrincipal(context, access, args.enterpriseApplication);
      if (!found.ok) return errText(found.error);
      const sp = found.value;
      const roles = appRolesOf(sp);
      const role = findAppRole(roles, args.appRole);
      if (!role.ok) return errText(role.error);
      if (!role.value.isEnabled) {
        return errText(
          `The app role ${role.value.displayName} is disabled; enable it in Entra first.`
        );
      }
      if (
        !role.value.allowedMemberTypes.includes('User') &&
        role.value.allowedMemberTypes.length > 0
      ) {
        return errText(
          `The app role ${role.value.displayName} is for applications only (allowedMemberTypes ` +
            `${role.value.allowedMemberTypes.join('/')}); users and groups cannot hold it.`
        );
      }
      const resolved = await resolveAssignees(context, access, args.assignees);
      if (!resolved.ok) return errText(resolved.error);
      const existing = await listAssignments(context, access, str(sp.id));
      const held = new Set(
        existing.ok
          ? existing.value.assignments
              .filter((a) => a.appRoleId === role.value.id)
              .map((a) => a.principalId)
          : []
      );
      const toAdd = resolved.principals.filter((p) => !held.has(p.id));
      const already = resolved.principals.filter((p) => held.has(p.id));
      if (toAdd.length === 0) {
        return textResult(
          `Everyone named already holds ${role.value.displayName} on ${str(sp.displayName)}: ` +
            already.map(principalLine).join(', ')
        );
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Assign app role',
        tone: 'positive',
        title: `Assign ${role.value.displayName} on ${str(sp.displayName)}`,
        subtitle: `Microsoft Entra · enterprise application ${str(sp.appId)}`,
        person: {
          name: toAdd.length === 1 ? toAdd[0].displayName : `${toAdd.length} users and groups`,
          detail: toAdd.length === 1 ? principalLine(toAdd[0]) : undefined,
        },
        secondaryPerson: {
          label: 'Application',
          name: str(sp.displayName),
          detail: `Application (client) id ${str(sp.appId)}`,
        },
        fields: [
          {
            label: 'Role',
            value: `${role.value.displayName}${role.value.value ? ` [${role.value.value}]` : ''}`,
          },
          ...(role.value.description
            ? [{ label: 'Role description', value: role.value.description }]
            : []),
        ],
        groupLists: [
          { label: 'Will be assigned', groups: toAdd.map(principalLine), tone: 'add' },
          ...(already.length > 0
            ? [
                {
                  label: 'Already assigned (skipped)',
                  groups: already.map(principalLine),
                  tone: 'muted' as const,
                },
              ]
            : []),
        ],
        confirmTool: 'entra_assign_app_role_confirm',
        confirmLabel: `Assign ${toAdd.length === 1 ? 'role' : `to ${toAdd.length}`}`,
        confirmArgs: {
          enterpriseApplication: str(sp.id),
          appRole: role.value.id,
          assignees: toAdd.map((p) => p.id),
        },
      });
    }
  );

  server.registerTool(
    'entra_assign_app_role_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed app role assignment',
      description:
        'Assign the app role the user confirmed on the preview card.' +
        confirmGuard('entra_assign_app_role_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: assignSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findServicePrincipal(context, access, args.enterpriseApplication);
      if (!found.ok) return errText(found.error);
      const sp = found.value;
      const role = findAppRole(appRolesOf(sp), args.appRole);
      if (!role.ok) return errText(role.error);
      const resolved = await resolveAssignees(context, access, args.assignees);
      if (!resolved.ok) return errText(resolved.error);
      const done: string[] = [];
      const failed: string[] = [];
      for (const principal of resolved.principals) {
        const created = await entraRequest(
          context,
          access,
          'POST',
          `/servicePrincipals/${str(sp.id)}/appRoleAssignedTo`,
          { principalId: principal.id, resourceId: str(sp.id), appRoleId: role.value.id }
        );
        if (created.ok) done.push(principalLine(principal));
        else failed.push(`${principalLine(principal)}: ${created.error}`);
      }
      const lines = [
        done.length > 0
          ? `Assigned ${role.value.displayName} on "${str(sp.displayName)}" to: ${done.join('; ')}.`
          : '',
        ...failed.map((f) => `Not assigned — ${f}`),
      ].filter(Boolean);
      return failed.length > 0 && done.length === 0
        ? errText(lines.join('\n'))
        : textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------
  // Remove an assignment.
  // -------------------------------------------------------------------

  const removeSchema = z.object({
    enterpriseApplication: servicePrincipalRefField,
    appRole: roleField,
    assignees: assigneesField.describe(
      'Who loses the role: each a user or group object id, a user’s address, or an exact display name.'
    ),
  });

  server.registerTool(
    'entra_remove_app_role_assignment_preview',
    {
      title: 'Entra Developer · Act — Preview removing an app role assignment',
      description:
        'Show the user a card to confirm or cancel taking an app role on an enterprise ' +
        'application away from users and groups. Anyone who does not hold the role is ' +
        'skipped. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: removeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findServicePrincipal(context, access, args.enterpriseApplication);
      if (!found.ok) return errText(found.error);
      const sp = found.value;
      const roles = appRolesOf(sp);
      const role = findAppRole(roles, args.appRole);
      if (!role.ok) return errText(role.error);
      const resolved = await resolveAssignees(context, access, args.assignees);
      if (!resolved.ok) return errText(resolved.error);
      const existing = await listAssignments(context, access, str(sp.id));
      if (!existing.ok) return errText(existing.error);
      const holding = new Set(
        existing.value.assignments
          .filter((a) => a.appRoleId === role.value.id)
          .map((a) => a.principalId)
      );
      const toRemove = resolved.principals.filter((p) => holding.has(p.id));
      const notHolding = resolved.principals.filter((p) => !holding.has(p.id));
      if (toRemove.length === 0) {
        return textResult(
          `No one named holds ${roleLabel(roles, role.value.id)} on ${str(sp.displayName)}: ` +
            notHolding.map(principalLine).join(', ')
        );
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Remove app role assignment',
        tone: 'caution',
        title: `Remove ${role.value.displayName} on ${str(sp.displayName)}`,
        subtitle: `Microsoft Entra · enterprise application ${str(sp.appId)}`,
        person: {
          name:
            toRemove.length === 1 ? toRemove[0].displayName : `${toRemove.length} users and groups`,
          detail: toRemove.length === 1 ? principalLine(toRemove[0]) : undefined,
        },
        secondaryPerson: {
          label: 'Application',
          name: str(sp.displayName),
          detail: `Application (client) id ${str(sp.appId)}`,
        },
        fields: [
          {
            label: 'Role',
            value: `${role.value.displayName}${role.value.value ? ` [${role.value.value}]` : ''}`,
          },
        ],
        groupLists: [
          { label: 'Will lose the role', groups: toRemove.map(principalLine), tone: 'remove' },
          ...(notHolding.length > 0
            ? [
                {
                  label: 'Do not hold it (skipped)',
                  groups: notHolding.map(principalLine),
                  tone: 'muted' as const,
                },
              ]
            : []),
        ],
        confirmTool: 'entra_remove_app_role_assignment_confirm',
        confirmLabel: 'Remove assignment',
        confirmArgs: {
          enterpriseApplication: str(sp.id),
          appRole: role.value.id,
          assignees: toRemove.map((p) => p.id),
        },
      });
    }
  );

  server.registerTool(
    'entra_remove_app_role_assignment_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed app role assignment removal',
      description:
        'Remove the app role assignments the user confirmed on the preview card.' +
        confirmGuard('entra_remove_app_role_assignment_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: removeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findServicePrincipal(context, access, args.enterpriseApplication);
      if (!found.ok) return errText(found.error);
      const sp = found.value;
      const role = findAppRole(appRolesOf(sp), args.appRole);
      if (!role.ok) return errText(role.error);
      const resolved = await resolveAssignees(context, access, args.assignees);
      if (!resolved.ok) return errText(resolved.error);
      const existing = await listAssignments(context, access, str(sp.id));
      if (!existing.ok) return errText(existing.error);
      const done: string[] = [];
      const failed: string[] = [];
      const skipped: string[] = [];
      for (const principal of resolved.principals) {
        const assignment = existing.value.assignments.find(
          (a) => a.appRoleId === role.value.id && a.principalId === principal.id
        );
        if (!assignment) {
          skipped.push(principalLine(principal));
          continue;
        }
        const deleted = await entraRequest(
          context,
          access,
          'DELETE',
          `/servicePrincipals/${str(sp.id)}/appRoleAssignedTo/${assignment.id}`
        );
        if (deleted.ok) done.push(principalLine(principal));
        else failed.push(`${principalLine(principal)}: ${deleted.error}`);
      }
      const lines = [
        done.length > 0
          ? `Removed ${role.value.displayName} on "${str(sp.displayName)}" from: ${done.join('; ')}.`
          : '',
        skipped.length > 0 ? `Did not hold it: ${skipped.join('; ')}.` : '',
        ...failed.map((f) => `Not removed — ${f}`),
      ].filter(Boolean);
      return failed.length > 0 && done.length === 0
        ? errText(lines.join('\n'))
        : textResult(lines.join('\n'));
    }
  );
}
