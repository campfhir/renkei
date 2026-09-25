/**
 * API permissions, both directions:
 *
 *  - what an app REQUESTS of other APIs (`requiredResourceAccess` — the
 *    portal's "API permissions" blade): list, add, remove, with each
 *    permission named by its value on the resource API ("User.Read" on
 *    Microsoft Graph) and resolved to the id Graph wants;
 *  - what an app EXPOSES for other apps to request (`api.oauth2PermissionScopes`
 *    — the "Expose an API" blade): delegated scopes, added and removed.
 *    Application permissions an app exposes are app roles for applications,
 *    which entra_add_app_roles already covers with allowedMemberTypes
 *    ["Application"].
 *
 * Granting admin consent is deliberately NOT here: it is a tenant-wide
 * decision, and Graph's route to it (writing oauth2PermissionGrants and
 * appRoleAssignments on the enterprise application) needs directory-wide
 * grant permissions this connector does not ask for. The preview names
 * which permissions will need it and links the portal blade where a person
 * grants it; the listing reports which application permissions are
 * already granted, which Graph does expose to Application.Read.All.
 */

import { randomUUID } from 'node:crypto';
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
import {
  entraGet,
  entraPages,
  entraRequest,
  errText,
  isGuid,
  odataString,
  rec,
  recs,
  str,
  strings,
  textResult,
  values,
  type EntraAccess,
  type EntraCallContext,
} from './client';
import { findApplication, servicePrincipalForAppId } from './resolve';
import { applicationRefField } from './applications';
import { previewResult } from './provision';
import { apiPermissionsLink } from './portal';

/** Microsoft Graph's application (client) id — the same in every directory. */
export const MICROSOFT_GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

const RESOURCE_SELECT = '$select=id,appId,displayName,oauth2PermissionScopes,appRoles';

/** One permission a resource API offers. */
export interface ResourcePermission {
  id: string;
  value: string;
  type: 'delegated' | 'application';
  /** Delegated: whether an admin must consent; application: always. */
  adminConsentRequired: boolean;
  displayName: string;
  description: string;
  isEnabled: boolean;
}

export interface ResourceApi {
  id: string;
  appId: string;
  displayName: string;
  permissions: ResourcePermission[];
}

function permissionsOf(sp: Record<string, unknown>): ResourcePermission[] {
  const delegated = recs(sp.oauth2PermissionScopes).map((scope): ResourcePermission => ({
    id: str(scope.id),
    value: str(scope.value),
    type: 'delegated',
    adminConsentRequired: str(scope.type) === 'Admin',
    displayName: str(scope.adminConsentDisplayName) || str(scope.userConsentDisplayName),
    description: str(scope.adminConsentDescription) || str(scope.userConsentDescription),
    isEnabled: scope.isEnabled !== false,
  }));
  const application = recs(sp.appRoles)
    .filter((role) => strings(role.allowedMemberTypes).includes('Application'))
    .map((role): ResourcePermission => ({
      id: str(role.id),
      value: str(role.value),
      type: 'application',
      adminConsentRequired: true,
      displayName: str(role.displayName),
      description: str(role.description),
      isEnabled: role.isEnabled !== false,
    }));
  return [...delegated, ...application];
}

type Found<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A resource API by application (client) id, service principal object id,
 * or exact display name — Microsoft Graph when nothing is given. A resource
 * has to have an enterprise application in this directory to be
 * requestable at all, so the lookup is on service principals.
 */
export async function findResourceApi(
  context: EntraCallContext,
  access: EntraAccess,
  reference: string | undefined
): Promise<Found<ResourceApi>> {
  const ref = (reference ?? '').trim() || MICROSOFT_GRAPH_APP_ID;
  let sp: Record<string, unknown> | undefined;
  if (isGuid(ref)) {
    const byAppId = await entraGet(
      context,
      access,
      `/servicePrincipals?$filter=${encodeURIComponent(`appId eq ${odataString(ref)}`)}&$top=1&${RESOURCE_SELECT}`
    );
    if (!byAppId.ok) return { ok: false, error: byAppId.error };
    sp = values(byAppId.body)[0];
    if (!sp) {
      const byId = await entraGet(context, access, `/servicePrincipals/${ref}?${RESOURCE_SELECT}`);
      if (byId.ok) sp = byId.body;
      else if (byId.status !== 404) return { ok: false, error: byId.error };
    }
    if (!sp) {
      return {
        ok: false,
        error: `No API with application id or object id ${ref} has an enterprise application in this directory.`,
      };
    }
  } else {
    const byName = await entraGet(
      context,
      access,
      `/servicePrincipals?$filter=${encodeURIComponent(`displayName eq ${odataString(ref)}`)}&$top=5&${RESOURCE_SELECT}`
    );
    if (!byName.ok) return { ok: false, error: byName.error };
    const matches = values(byName.body);
    if (matches.length === 0) {
      return { ok: false, error: `No API is named exactly "${ref}" in this directory.` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error:
          `${matches.length} APIs are named "${ref}"; pass one by application id: ` +
          matches.map((m) => `${str(m.appId)} (${str(m.displayName)})`).join(', '),
      };
    }
    sp = matches[0];
  }
  return {
    ok: true,
    value: {
      id: str(sp.id),
      appId: str(sp.appId),
      displayName: str(sp.displayName),
      permissions: permissionsOf(sp),
    },
  };
}

/** A permission on a resource by value (case-insensitive) or id, of the given type. */
export function findPermission(
  resource: ResourceApi,
  reference: string,
  type: 'delegated' | 'application'
): Found<ResourcePermission> {
  const ref = reference.trim().toLowerCase();
  const ofType = resource.permissions.filter((p) => p.type === type);
  const match = ofType.find((p) => p.id.toLowerCase() === ref || p.value.toLowerCase() === ref);
  if (match) return { ok: true, value: match };
  const otherType = resource.permissions.find(
    (p) => p.type !== type && (p.id.toLowerCase() === ref || p.value.toLowerCase() === ref)
  );
  return {
    ok: false,
    error: otherType
      ? `${resource.displayName} offers "${reference}" as ${otherType.type === 'delegated' ? 'a delegated' : 'an application'} permission, not ${type === 'delegated' ? 'a delegated' : 'an application'} one; pass type "${otherType.type}".`
      : `${resource.displayName} offers no ${type} permission "${reference}". entra_search_api_permissions finds what it does offer.`,
  };
}

function describePermission(p: ResourcePermission): string {
  return (
    `${p.value} — ${p.type}` +
    (p.adminConsentRequired ? ', admin consent required' : '') +
    (p.isEnabled ? '' : ', disabled') +
    (p.displayName ? ` — ${p.displayName}` : '')
  );
}

/** requiredResourceAccess as Graph shapes it. */
interface RequiredResource {
  resourceAppId: string;
  resourceAccess: { id: string; type: 'Scope' | 'Role' }[];
}

function requiredResourcesOf(app: Record<string, unknown>): RequiredResource[] {
  return recs(app.requiredResourceAccess).map((entry) => ({
    resourceAppId: str(entry.resourceAppId),
    resourceAccess: recs(entry.resourceAccess)
      .map((a) => ({
        id: str(a.id),
        type: str(a.type) === 'Role' ? ('Role' as const) : ('Scope' as const),
      }))
      .filter((a) => a.id),
  }));
}

const graphType = (type: 'delegated' | 'application'): 'Scope' | 'Role' =>
  type === 'delegated' ? 'Scope' : 'Role';

const REQUIRED_SELECT = '$select=id,appId,displayName,requiredResourceAccess';

async function readRequired(
  context: EntraCallContext,
  access: EntraAccess,
  appObjectId: string
): Promise<Found<RequiredResource[]>> {
  const result = await entraGet(context, access, `/applications/${appObjectId}?${REQUIRED_SELECT}`);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: requiredResourcesOf(result.body) };
}

const permissionInput = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'The permission’s value on the resource API, e.g. "User.Read" or "Mail.Send", or its id.'
    ),
  type: z
    .enum(['delegated', 'application'])
    .optional()
    .describe(
      'Delegated (acts as the signed-in user — the default) or application (acts as the app itself; always needs admin consent).'
    ),
});

const resourceField = z
  .string()
  .optional()
  .describe(
    'The API the permissions belong to: its display name ("Microsoft Graph"), application ' +
      '(client) id, or enterprise application object id. Microsoft Graph when omitted.'
  );

export async function registerPermissionTools(
  server: McpServer,
  context: MCPToolContext,
  auth: EntraAuth
): Promise<void> {
  // -------------------------------------------------------------------
  // What a resource API offers.
  // -------------------------------------------------------------------

  server.registerTool(
    'entra_search_api_permissions',
    {
      title: 'Entra Developer · Read — Find permissions an API offers',
      description:
        'The permissions a resource API (Microsoft Graph by default, or any API with an ' +
        'enterprise application in this directory — including your own apps) offers, ' +
        'optionally narrowed to values containing a term: delegated and application, and ' +
        'whether each needs admin consent. Use it to pick what entra_add_api_permissions ' +
        'should request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        resource: resourceField,
        query: z
          .string()
          .optional()
          .describe('Part of a permission value, e.g. "Mail" or "User.Read".'),
        type: z
          .enum(['delegated', 'application'])
          .optional()
          .describe('Only delegated or only application permissions; both when omitted.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('At most this many (default 50).'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const resource = await findResourceApi(context, access, args.resource);
      if (!resource.ok) return errText(resource.error);
      const term = (args.query ?? '').trim().toLowerCase();
      const limit = args.limit ?? 50;
      const matching = resource.value.permissions
        .filter((p) => (args.type ? p.type === args.type : true))
        .filter((p) =>
          term
            ? p.value.toLowerCase().includes(term) || p.displayName.toLowerCase().includes(term)
            : true
        )
        .sort((a, b) => a.value.localeCompare(b.value));
      if (matching.length === 0) {
        return textResult(
          `${resource.value.displayName} offers no ${args.type ?? ''} permission${term ? ` containing "${args.query}"` : ''}.`
        );
      }
      const shown = matching.slice(0, limit);
      return textResult(
        [
          `${resource.value.displayName} (appId ${resource.value.appId}) — ${matching.length} permission${matching.length === 1 ? '' : 's'}` +
            (shown.length < matching.length ? `, first ${shown.length} shown` : '') +
            ':',
          ...shown.map((p) => `  • ${describePermission(p)}`),
        ].join('\n')
      );
    }
  );

  // -------------------------------------------------------------------
  // What an app requests.
  // -------------------------------------------------------------------

  server.registerTool(
    'entra_list_api_permissions',
    {
      title: 'Entra Developer · Read — List an app’s API permissions',
      description:
        'The API permissions an app registration requests (its "API permissions" blade), ' +
        'per resource API, each named and marked delegated or application and whether it ' +
        'needs admin consent; application permissions already granted to its enterprise ' +
        'application are marked granted. Ends with the portal link where an admin grants consent.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ application: applicationRefField }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const required = await readRequired(context, access, str(app.id));
      if (!required.ok) return errText(required.error);
      if (required.value.length === 0) {
        return textResult(
          `${str(app.displayName)} requests no API permissions.\nAdd some with entra_add_api_permissions_preview; grant admin consent at ${apiPermissionsLink(str(app.appId))}`
        );
      }
      // Which application permissions its enterprise application already holds.
      const granted = new Set<string>();
      const sp = await servicePrincipalForAppId(context, access, str(app.appId));
      if (sp.ok && sp.value) {
        const assignments = await entraPages(
          context,
          access,
          `/servicePrincipals/${str(sp.value.id)}/appRoleAssignments?$top=100`
        );
        if (assignments.ok) {
          for (const a of assignments.values)
            granted.add(`${str(a.resourceId)}:${str(a.appRoleId)}`);
        }
      }
      const lines = [`${str(app.displayName)} requests:`];
      let needsConsent = false;
      for (const entry of required.value) {
        const resource = await findResourceApi(context, access, entry.resourceAppId);
        const name = resource.ok
          ? resource.value.displayName
          : `unknown API ${entry.resourceAppId}`;
        lines.push(`${name} (appId ${entry.resourceAppId}):`);
        for (const item of entry.resourceAccess) {
          const type = item.type === 'Role' ? 'application' : 'delegated';
          const known = resource.ok
            ? resource.value.permissions.find((p) => p.id === item.id && p.type === type)
            : undefined;
          const isGranted =
            type === 'application' && resource.ok && granted.has(`${resource.value.id}:${item.id}`);
          if (known?.adminConsentRequired && !isGranted) needsConsent = true;
          lines.push(
            `  • ${known ? known.value : `id ${item.id}`} — ${type}` +
              (known?.adminConsentRequired ? ', admin consent required' : '') +
              (type === 'application' ? (isGranted ? ' — granted' : ' — not granted yet') : '') +
              (known?.displayName ? ` — ${known.displayName}` : '')
          );
        }
      }
      lines.push(
        (needsConsent
          ? 'Some of these need an admin to grant consent. '
          : 'Delegated consent status is shown on the portal. ') +
          `API permissions blade: ${apiPermissionsLink(str(app.appId))}`
      );
      return textResult(lines.join('\n'));
    }
  );

  const addSchema = z.object({
    application: applicationRefField,
    resource: resourceField,
    permissions: z.array(permissionInput).min(1).max(50).describe('The permissions to request.'),
  });

  /** Resolve the requested permissions on the resource, all or nothing. */
  async function resolveRequested(
    access: EntraAccess,
    args: z.infer<typeof addSchema>
  ): Promise<Found<{ resource: ResourceApi; permissions: ResourcePermission[] }>> {
    const resource = await findResourceApi(context, access, args.resource);
    if (!resource.ok) return resource;
    const permissions: ResourcePermission[] = [];
    const seen = new Set<string>();
    for (const input of args.permissions) {
      const type = input.type ?? 'delegated';
      const permission = findPermission(resource.value, input.name, type);
      if (!permission.ok) return permission;
      if (seen.has(permission.value.id)) continue;
      seen.add(permission.value.id);
      permissions.push(permission.value);
    }
    return { ok: true, value: { resource: resource.value, permissions } };
  }

  server.registerTool(
    'entra_add_api_permissions_preview',
    {
      title: 'Entra Developer · Act — Preview adding API permissions',
      description:
        'Show the user a card to confirm or cancel adding API permissions to an app ' +
        'registration — delegated or application permissions of Microsoft Graph or any other ' +
        'API in this directory, named by value ("User.Read"). Existing permissions are kept. ' +
        'Adding only REQUESTS them: the card says which will then need an admin to grant ' +
        'consent, and the result links the portal blade for that. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: addSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const resolved = await resolveRequested(access, args);
      if (!resolved.ok) return errText(resolved.error);
      const { resource, permissions } = resolved.value;
      const required = await readRequired(context, access, str(app.id));
      if (!required.ok) return errText(required.error);
      const current = new Set(
        (required.value.find((r) => r.resourceAppId === resource.appId)?.resourceAccess ?? []).map(
          (a) => a.id
        )
      );
      const toAdd = permissions.filter((p) => !current.has(p.id));
      const already = permissions.filter((p) => current.has(p.id));
      if (toAdd.length === 0) {
        return textResult(
          `${str(app.displayName)} already requests ${already.map((p) => p.value).join(', ')} on ${resource.displayName}.`
        );
      }
      const consent = toAdd.filter((p) => p.adminConsentRequired);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Add API permissions',
        tone: 'positive',
        title: `Request ${toAdd.length} ${resource.displayName} permission${toAdd.length === 1 ? '' : 's'} for ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        secondaryPerson: {
          label: 'API',
          name: resource.displayName,
          detail: `appId ${resource.appId}`,
        },
        fields:
          consent.length > 0
            ? [
                {
                  label: 'Admin consent needed afterwards',
                  value: consent.map((p) => p.value).join(', '),
                },
              ]
            : undefined,
        groupLists: [
          { label: 'Will be requested', groups: toAdd.map(describePermission), tone: 'add' },
          ...(already.length > 0
            ? [
                {
                  label: 'Already requested (skipped)',
                  groups: already.map((p) => p.value),
                  tone: 'muted' as const,
                },
              ]
            : []),
        ],
        confirmTool: 'entra_add_api_permissions_confirm',
        confirmLabel: 'Request permissions',
        confirmArgs: {
          application: str(app.id),
          resource: resource.appId,
          permissions: toAdd.map((p) => ({ name: p.id, type: p.type })),
        },
      });
    }
  );

  server.registerTool(
    'entra_add_api_permissions_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed API permission addition',
      description:
        'Request the API permissions the user confirmed on the preview card.' +
        confirmGuard('entra_add_api_permissions_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: addSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const resolved = await resolveRequested(access, args);
      if (!resolved.ok) return errText(resolved.error);
      const { resource, permissions } = resolved.value;
      const required = await readRequired(context, access, str(app.id));
      if (!required.ok) return errText(required.error);
      // requiredResourceAccess is replaced wholesale, so every other
      // resource rides along untouched and this one gains the new ids.
      const merged = required.value.map((r) => ({ ...r, resourceAccess: [...r.resourceAccess] }));
      let entry = merged.find((r) => r.resourceAppId === resource.appId);
      if (!entry) {
        entry = { resourceAppId: resource.appId, resourceAccess: [] };
        merged.push(entry);
      }
      const present = new Set(entry.resourceAccess.map((a) => a.id));
      for (const p of permissions) {
        if (!present.has(p.id)) entry.resourceAccess.push({ id: p.id, type: graphType(p.type) });
      }
      const patched = await entraRequest(context, access, 'PATCH', `/applications/${str(app.id)}`, {
        requiredResourceAccess: merged,
      });
      if (!patched.ok) {
        return errText(
          `Could not add API permissions to ${str(app.displayName)}: ${patched.error}`
        );
      }
      const consent = permissions.filter((p) => p.adminConsentRequired);
      return textResult(
        [
          `Requested ${permissions.map((p) => `${p.value} (${p.type})`).join(', ')} on ${resource.displayName} for "${str(app.displayName)}".`,
          consent.length > 0
            ? `${consent.map((p) => p.value).join(', ')} need${consent.length === 1 ? 's' : ''} an admin to grant consent before the app can use ${consent.length === 1 ? 'it' : 'them'}: ${apiPermissionsLink(str(app.appId))}`
            : `Users consent to these on first sign-in, or an admin grants them for everyone at ${apiPermissionsLink(str(app.appId))}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'entra_remove_api_permissions_preview',
    {
      title: 'Entra Developer · Act — Preview removing API permissions',
      description:
        'Show the user a card to confirm or cancel removing API permissions an app ' +
        'registration requests, named by value. Consent already granted for them is not ' +
        'revoked here — the portal’s enterprise application Permissions blade does that. ' +
        'The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: addSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const resolved = await resolveRequested(access, args);
      if (!resolved.ok) return errText(resolved.error);
      const { resource, permissions } = resolved.value;
      const required = await readRequired(context, access, str(app.id));
      if (!required.ok) return errText(required.error);
      const current = new Set(
        (required.value.find((r) => r.resourceAppId === resource.appId)?.resourceAccess ?? []).map(
          (a) => a.id
        )
      );
      const toRemove = permissions.filter((p) => current.has(p.id));
      const absent = permissions.filter((p) => !current.has(p.id));
      if (toRemove.length === 0) {
        return textResult(
          `${str(app.displayName)} does not request ${absent.map((p) => p.value).join(', ')} on ${resource.displayName}.`
        );
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Remove API permissions',
        tone: 'caution',
        title: `Stop requesting ${toRemove.length} ${resource.displayName} permission${toRemove.length === 1 ? '' : 's'} for ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        secondaryPerson: {
          label: 'API',
          name: resource.displayName,
          detail: `appId ${resource.appId}`,
        },
        groupLists: [
          {
            label: 'Will no longer be requested',
            groups: toRemove.map(describePermission),
            tone: 'remove',
          },
          ...(absent.length > 0
            ? [
                {
                  label: 'Not requested (skipped)',
                  groups: absent.map((p) => p.value),
                  tone: 'muted' as const,
                },
              ]
            : []),
        ],
        confirmTool: 'entra_remove_api_permissions_confirm',
        confirmLabel: 'Remove permissions',
        confirmArgs: {
          application: str(app.id),
          resource: resource.appId,
          permissions: toRemove.map((p) => ({ name: p.id, type: p.type })),
        },
      });
    }
  );

  server.registerTool(
    'entra_remove_api_permissions_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed API permission removal',
      description:
        'Remove the API permissions the user confirmed on the preview card.' +
        confirmGuard('entra_remove_api_permissions_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: addSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const resolved = await resolveRequested(access, args);
      if (!resolved.ok) return errText(resolved.error);
      const { resource, permissions } = resolved.value;
      const required = await readRequired(context, access, str(app.id));
      if (!required.ok) return errText(required.error);
      const dropping = new Set(permissions.map((p) => p.id));
      const merged = required.value
        .map((r) =>
          r.resourceAppId === resource.appId
            ? { ...r, resourceAccess: r.resourceAccess.filter((a) => !dropping.has(a.id)) }
            : r
        )
        // A resource left with nothing is dropped, as the portal does.
        .filter((r) => r.resourceAccess.length > 0);
      const patched = await entraRequest(context, access, 'PATCH', `/applications/${str(app.id)}`, {
        requiredResourceAccess: merged,
      });
      if (!patched.ok) {
        return errText(
          `Could not remove API permissions from ${str(app.displayName)}: ${patched.error}`
        );
      }
      return textResult(
        `"${str(app.displayName)}" no longer requests ${permissions.map((p) => p.value).join(', ')} on ${resource.displayName}. ` +
          'Consent already granted stays until revoked on the enterprise application’s Permissions blade.'
      );
    }
  );

  // -------------------------------------------------------------------
  // What an app exposes: delegated scopes.
  // -------------------------------------------------------------------

  const scopeSchema = z.object({
    application: applicationRefField,
    value: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,120}$/, 'letters, digits, dot, underscore or hyphen')
      .describe('The scope name clients request, e.g. "Tasks.Read" or "access_as_user".'),
    adminConsentDisplayName: z
      .string()
      .min(1)
      .max(100)
      .describe('The title admins see when consenting.'),
    adminConsentDescription: z
      .string()
      .min(1)
      .max(1000)
      .describe('What admins are told the scope allows.'),
    userConsentDisplayName: z
      .string()
      .max(100)
      .optional()
      .describe('The title users see (admin title when omitted).'),
    userConsentDescription: z
      .string()
      .max(1000)
      .optional()
      .describe('What users are told (admin description when omitted).'),
    consent: z
      .enum(['User', 'Admin'])
      .optional()
      .describe(
        'Who can consent: any user for themselves (User — the default), or admins only (Admin).'
      ),
  });

  function scopesOf(app: Record<string, unknown>): Record<string, unknown>[] {
    return recs(rec(app.api).oauth2PermissionScopes);
  }

  server.registerTool(
    'entra_add_api_scope_preview',
    {
      title: 'Entra Developer · Act — Preview exposing a delegated scope',
      description:
        'Show the user a card to confirm or cancel adding a delegated permission scope to an ' +
        'app registration’s exposed API ("Expose an API"), so other apps can request it. ' +
        'Sets the Application ID URI to api://<client id> first when the app has none. For an ' +
        'APPLICATION permission other apps can request, add an app role with ' +
        'allowedMemberTypes ["Application"] instead. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: scopeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const existing = scopesOf(app);
      if (existing.some((s) => str(s.value).toLowerCase() === args.value.toLowerCase())) {
        return errText(`${str(app.displayName)} already exposes a scope named ${args.value}.`);
      }
      const identifierUris = strings(app.identifierUris);
      const uri = identifierUris[0] ?? `api://${str(app.appId)}`;
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Expose a scope',
        tone: 'positive',
        title: `Expose ${args.value} on ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        fields: [
          { label: 'Full scope', value: `${uri}/${args.value}` },
          ...(identifierUris.length === 0
            ? [{ label: 'Application ID URI', value: `${uri} (set now — the app has none)` }]
            : []),
          {
            label: 'Who can consent',
            value: args.consent === 'Admin' ? 'Admins only' : 'Any user, for themselves',
          },
          { label: 'Admin consent title', value: args.adminConsentDisplayName },
          { label: 'Admin consent description', value: args.adminConsentDescription },
          ...(args.userConsentDisplayName
            ? [{ label: 'User consent title', value: args.userConsentDisplayName }]
            : []),
          ...(args.userConsentDescription
            ? [{ label: 'User consent description', value: args.userConsentDescription }]
            : []),
          ...(existing.length > 0
            ? [
                {
                  label: 'Scopes it already exposes',
                  value: existing.map((s) => str(s.value)).join(', '),
                },
              ]
            : []),
        ],
        confirmTool: 'entra_add_api_scope_confirm',
        confirmLabel: 'Expose scope',
        confirmArgs: { ...args, application: str(app.id) },
      });
    }
  );

  server.registerTool(
    'entra_add_api_scope_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed scope exposure',
      description:
        'Expose the delegated scope the user confirmed on the preview card.' +
        confirmGuard('entra_add_api_scope_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: scopeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const existing = scopesOf(app);
      if (existing.some((s) => str(s.value).toLowerCase() === args.value.toLowerCase())) {
        return errText(`${str(app.displayName)} already exposes a scope named ${args.value}.`);
      }
      const identifierUris = strings(app.identifierUris);
      const body: Record<string, unknown> = {
        // `api` is sent back whole, with the scopes list extended, so its
        // other settings (known clients, token version) are untouched.
        api: {
          ...rec(app.api),
          oauth2PermissionScopes: [
            ...existing,
            {
              id: randomUUID(),
              value: args.value,
              type: args.consent ?? 'User',
              isEnabled: true,
              adminConsentDisplayName: args.adminConsentDisplayName,
              adminConsentDescription: args.adminConsentDescription,
              userConsentDisplayName: args.userConsentDisplayName ?? args.adminConsentDisplayName,
              userConsentDescription: args.userConsentDescription ?? args.adminConsentDescription,
            },
          ],
        },
        ...(identifierUris.length === 0 ? { identifierUris: [`api://${str(app.appId)}`] } : {}),
      };
      const patched = await entraRequest(
        context,
        access,
        'PATCH',
        `/applications/${str(app.id)}`,
        body
      );
      if (!patched.ok)
        return errText(
          `Could not expose ${args.value} on ${str(app.displayName)}: ${patched.error}`
        );
      const uri = identifierUris[0] ?? `api://${str(app.appId)}`;
      return textResult(
        `"${str(app.displayName)}" now exposes ${uri}/${args.value}` +
          (identifierUris.length === 0 ? ` (Application ID URI set to ${uri})` : '') +
          '. Other apps request it with entra_add_api_permissions_preview, naming this app as the resource.'
      );
    }
  );

  const removeScopeSchema = z.object({
    application: applicationRefField,
    value: z.string().min(1).describe('The scope to remove: its value or id.'),
  });

  server.registerTool(
    'entra_remove_api_scope_preview',
    {
      title: 'Entra Developer · Act — Preview removing an exposed scope',
      description:
        'Show the user a card to confirm or cancel removing a delegated scope an app ' +
        'registration exposes. Entra requires the scope disabled before removal; the confirm ' +
        'does both. Apps that request it stop being able to. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: removeScopeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const ref = args.value.trim().toLowerCase();
      const scope = scopesOf(app).find(
        (s) => str(s.id).toLowerCase() === ref || str(s.value).toLowerCase() === ref
      );
      if (!scope) {
        const names = scopesOf(app).map((s) => str(s.value));
        return errText(
          `${str(app.displayName)} exposes no scope "${args.value}".` +
            (names.length > 0 ? ` It exposes: ${names.join(', ')}` : ' It exposes none.')
        );
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Remove exposed scope',
        tone: 'caution',
        title: `Remove ${str(scope.value)} from ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        fields: [
          {
            label: 'Scope',
            value: `${str(scope.value)} — ${str(scope.adminConsentDisplayName)} (id ${str(scope.id)})`,
          },
        ],
        confirmTool: 'entra_remove_api_scope_confirm',
        confirmLabel: 'Remove scope',
        confirmArgs: { application: str(app.id), value: str(scope.id) },
      });
    }
  );

  server.registerTool(
    'entra_remove_api_scope_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed scope removal',
      description:
        'Disable and remove the exposed scope the user confirmed on the preview card.' +
        confirmGuard('entra_remove_api_scope_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: removeScopeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const ref = args.value.trim().toLowerCase();
      const scopes = scopesOf(app);
      const scope = scopes.find(
        (s) => str(s.id).toLowerCase() === ref || str(s.value).toLowerCase() === ref
      );
      if (!scope) return errText(`${str(app.displayName)} exposes no scope "${args.value}".`);
      const api = rec(app.api);
      const path = `/applications/${str(app.id)}`;
      if (scope.isEnabled !== false) {
        const disabled = await entraRequest(context, access, 'PATCH', path, {
          api: {
            ...api,
            oauth2PermissionScopes: scopes.map((s) =>
              str(s.id) === str(scope.id) ? { ...s, isEnabled: false } : s
            ),
          },
        });
        if (!disabled.ok)
          return errText(`Could not disable ${str(scope.value)}: ${disabled.error}`);
      }
      const removed = await entraRequest(context, access, 'PATCH', path, {
        api: { ...api, oauth2PermissionScopes: scopes.filter((s) => str(s.id) !== str(scope.id)) },
      });
      if (!removed.ok) {
        return errText(
          `Disabled ${str(scope.value)} but could not remove it: ${removed.error}. Run the preview again to retry.`
        );
      }
      return textResult(
        `Removed exposed scope ${str(scope.value)} from "${str(app.displayName)}".`
      );
    }
  );
}
