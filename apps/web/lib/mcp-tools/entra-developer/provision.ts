/**
 * The entra_ provisioning tools: create an app registration (with, by
 * default, its enterprise application, and optionally its app roles),
 * change one, give an existing registration an enterprise application,
 * and add or remove app roles.
 *
 * Every write is preview + confirm on the directory_action_preview card
 * (the ADManager Plus rule, for the same reason: these are identity
 * objects the whole organization signs in through, and a wrong redirect
 * URI or a role handed to the wrong group has no undo history). The
 * preview resolves every reference and shows exactly what will be sent;
 * the confirm re-resolves and sends it.
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
import { entraRequest, errText, rec, str, strings, textResult } from './client';
import {
  APPLICATION_SELECT,
  appRolesOf,
  describeRole,
  findApplication,
  findAppRole,
  listAssignments,
  servicePrincipalForAppId,
  type AppRole,
} from './resolve';
import { applicationRefField, describeApplication } from './applications';
import { apiPermissionsLink, secretsLink } from './portal';

/** The directory_action_preview card's structuredContent (see mcp-widgets). */
export interface DirectoryActionPreview {
  kind: 'directory_action';
  previewId: string;
  action: string;
  tone: 'positive' | 'caution' | 'neutral';
  title: string;
  subtitle: string;
  person: { name: string; detail?: string };
  secondaryPerson?: { label: string; name: string; detail?: string };
  fields?: { label: string; value: string; oldValue?: string }[];
  groupLists?: { label: string; groups: string[]; tone?: 'add' | 'remove' | 'muted' }[];
  confirmTool: string;
  confirmLabel: string;
  confirmArgs: Record<string, unknown>;
}

export function previewResult(preview: DirectoryActionPreview) {
  return {
    content: [
      { type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' },
    ],
    structuredContent: preview,
  };
}

const SIGN_IN_AUDIENCES = [
  'AzureADMyOrg',
  'AzureADMultipleOrgs',
  'AzureADandPersonalMicrosoftAccount',
  'PersonalMicrosoftAccount',
] as const;

const AUDIENCE_LABEL: Record<(typeof SIGN_IN_AUDIENCES)[number], string> = {
  AzureADMyOrg: 'This organization only (single tenant)',
  AzureADMultipleOrgs: 'Any Microsoft Entra directory (multitenant)',
  AzureADandPersonalMicrosoftAccount: 'Any Entra directory and personal Microsoft accounts',
  PersonalMicrosoftAccount: 'Personal Microsoft accounts only',
};

const uriList = (what: string) =>
  z
    .array(z.string().url())
    .optional()
    .describe(
      `${what} redirect URIs. Each must be an absolute https URL (http only for localhost).`
    );

const appRoleInput = z.object({
  displayName: z.string().min(1).max(120).describe('What the role is called in the portal.'),
  value: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,120}$/, 'letters, digits, dot, underscore or hyphen')
    .describe(
      'The claim value tokens carry (roles claim), e.g. "Task.Write" or "Admin". Unique within ' +
        'the application.'
    ),
  description: z.string().min(1).max(1024).describe('What holders of the role may do.'),
  allowedMemberTypes: z
    .array(z.enum(['User', 'Application']))
    .min(1)
    .optional()
    .describe(
      'Who can hold it: ["User"] for users and groups (default), ["Application"] for other ' +
        'applications, or both.'
    ),
});

type AppRoleInput = z.infer<typeof appRoleInput>;

function validRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function badRedirects(...lists: (string[] | undefined)[]): string[] {
  return lists.flatMap((list) => list ?? []).filter((uri) => !validRedirect(uri));
}

/** New app roles as Graph wants them, each with a fresh id. */
function toGraphRoles(roles: AppRoleInput[]): Record<string, unknown>[] {
  return roles.map((role) => ({
    id: randomUUID(),
    displayName: role.displayName,
    value: role.value,
    description: role.description,
    allowedMemberTypes: role.allowedMemberTypes ?? ['User'],
    isEnabled: true,
  }));
}

function duplicateValues(existing: AppRole[], added: AppRoleInput[]): string[] {
  const seen = new Set(existing.map((role) => role.value.toLowerCase()).filter(Boolean));
  const duplicates: string[] = [];
  for (const role of added) {
    const key = role.value.toLowerCase();
    if (seen.has(key)) duplicates.push(role.value);
    seen.add(key);
  }
  return duplicates;
}

function roleLines(roles: AppRoleInput[]): string[] {
  return roles.map(
    (role) =>
      `${role.displayName} [${role.value}] — ${role.description} (${(role.allowedMemberTypes ?? ['User']).join('/')})`
  );
}

export async function registerProvisionTools(
  server: McpServer,
  context: MCPToolContext,
  auth: EntraAuth
): Promise<void> {
  // -------------------------------------------------------------------
  // Create an app registration (and, by default, its enterprise application).
  // -------------------------------------------------------------------

  const createSchema = z.object({
    displayName: z.string().min(1).max(120).describe('The application’s display name.'),
    signInAudience: z
      .enum(SIGN_IN_AUDIENCES)
      .optional()
      .describe(
        'Who can sign in: AzureADMyOrg (this organization only — the default), ' +
          'AzureADMultipleOrgs, AzureADandPersonalMicrosoftAccount, PersonalMicrosoftAccount.'
      ),
    description: z.string().max(1024).optional().describe('A short description of the app.'),
    webRedirectUris: uriList('Web platform (server-side apps)'),
    spaRedirectUris: uriList('Single-page application'),
    publicClientRedirectUris: uriList('Mobile and desktop application'),
    identifierUris: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Application ID URIs (api://… or a verified-domain URL) for an API other apps call. ' +
          'Usually left for later; api://<client id> cannot be set before the id exists.'
      ),
    appRoles: z
      .array(appRoleInput)
      .max(50)
      .optional()
      .describe('App roles to define from the start (each needs a unique value).'),
    createEnterpriseApplication: z
      .boolean()
      .optional()
      .describe(
        'Also create the enterprise application (service principal) in this directory, so ' +
          'users and groups can be assigned to it — default true. False registers the app only.'
      ),
  });

  async function createApplication(args: z.infer<typeof createSchema>) {
    const access = await auth.resolve();
    if (typeof access === 'string') return errText(access);
    const bad = badRedirects(
      args.webRedirectUris,
      args.spaRedirectUris,
      args.publicClientRedirectUris
    );
    if (bad.length > 0) {
      return errText(
        `Redirect URIs must be absolute https URLs (http only for localhost): ${bad.join(', ')}`
      );
    }
    const duplicates = duplicateValues([], args.appRoles ?? []);
    if (duplicates.length > 0) {
      return errText(`App role values must be unique: ${duplicates.join(', ')}`);
    }
    const body: Record<string, unknown> = {
      displayName: args.displayName,
      signInAudience: args.signInAudience ?? 'AzureADMyOrg',
      ...(args.description ? { description: args.description } : {}),
      ...(args.webRedirectUris?.length ? { web: { redirectUris: args.webRedirectUris } } : {}),
      ...(args.spaRedirectUris?.length ? { spa: { redirectUris: args.spaRedirectUris } } : {}),
      ...(args.publicClientRedirectUris?.length
        ? { publicClient: { redirectUris: args.publicClientRedirectUris } }
        : {}),
      ...(args.identifierUris?.length ? { identifierUris: args.identifierUris } : {}),
      ...(args.appRoles?.length ? { appRoles: toGraphRoles(args.appRoles) } : {}),
    };
    const created = await entraRequest(context, access, 'POST', '/applications', body);
    if (!created.ok) return errText(`Could not create the app registration: ${created.error}`);
    const app = created.body;
    const lines = [
      `Created app registration "${str(app.displayName)}".`,
      ...describeApplication(app).slice(1),
    ];
    if (args.createEnterpriseApplication !== false) {
      const sp = await entraRequest(context, access, 'POST', '/servicePrincipals', {
        appId: str(app.appId),
      });
      if (sp.ok) {
        lines.push(
          `Enterprise application: created — object id ${str(sp.body.id)}. Assign users and ` +
            'groups to its roles with entra_assign_app_role_preview.'
        );
      } else {
        lines.push(
          `Enterprise application: NOT created (${sp.error}). The registration exists; ` +
            'entra_create_enterprise_application_preview can add it.'
        );
      }
    } else {
      lines.push('Enterprise application: not created, as asked.');
    }
    lines.push(
      `Next, on the portal: add a client secret or certificate at ${secretsLink(str(app.appId))}; ` +
        `request API permissions with entra_add_api_permissions_preview and grant admin consent at ${apiPermissionsLink(str(app.appId))}.`
    );
    return textResult(lines.join('\n'));
  }

  server.registerTool(
    'entra_create_application_preview',
    {
      title: 'Entra Developer · Act — Preview creating an application',
      description:
        'Show the user a card to confirm or cancel creating a Microsoft Entra app registration ' +
        '— with its enterprise application (so users and groups can be assigned) unless told ' +
        'otherwise, and any app roles given. This is the only way to create an application ' +
        'here — the user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: createSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const bad = badRedirects(
        args.webRedirectUris,
        args.spaRedirectUris,
        args.publicClientRedirectUris
      );
      if (bad.length > 0) {
        return errText(
          `Redirect URIs must be absolute https URLs (http only for localhost): ${bad.join(', ')}`
        );
      }
      const duplicates = duplicateValues([], args.appRoles ?? []);
      if (duplicates.length > 0) {
        return errText(`App role values must be unique: ${duplicates.join(', ')}`);
      }
      const audience = args.signInAudience ?? 'AzureADMyOrg';
      const withEnterprise = args.createEnterpriseApplication !== false;
      const fields = [
        { label: 'Sign-in audience', value: AUDIENCE_LABEL[audience] },
        {
          label: 'Enterprise application',
          value: withEnterprise ? 'Created alongside' : 'Not created (registration only)',
        },
        ...(args.description ? [{ label: 'Description', value: args.description }] : []),
        ...(args.webRedirectUris?.length
          ? [{ label: 'Web redirect URIs', value: args.webRedirectUris.join('\n') }]
          : []),
        ...(args.spaRedirectUris?.length
          ? [{ label: 'Single-page app redirect URIs', value: args.spaRedirectUris.join('\n') }]
          : []),
        ...(args.publicClientRedirectUris?.length
          ? [
              {
                label: 'Mobile/desktop redirect URIs',
                value: args.publicClientRedirectUris.join('\n'),
              },
            ]
          : []),
        ...(args.identifierUris?.length
          ? [{ label: 'Identifier URIs', value: args.identifierUris.join('\n') }]
          : []),
      ];
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Create application',
        tone: 'positive',
        title: `Create ${args.displayName}`,
        subtitle: `Microsoft Entra · ${access.upn || 'your directory'}`,
        person: { name: args.displayName, detail: 'New app registration' },
        fields,
        groupLists: args.appRoles?.length
          ? [{ label: 'App roles', groups: roleLines(args.appRoles), tone: 'add' }]
          : undefined,
        confirmTool: 'entra_create_application_confirm',
        confirmLabel: withEnterprise ? 'Create application' : 'Create registration',
        confirmArgs: args,
      });
    }
  );

  server.registerTool(
    'entra_create_application_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed application creation',
      description:
        'Create the application the user confirmed on the preview card.' +
        confirmGuard('entra_create_application_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: createSchema,
    },
    createApplication
  );

  // -------------------------------------------------------------------
  // Update an app registration: name, redirect URIs, identifier URIs.
  // -------------------------------------------------------------------

  const updateSchema = z.object({
    application: applicationRefField,
    displayName: z.string().min(1).max(120).optional().describe('A new display name.'),
    description: z.string().max(1024).optional().describe('A new description.'),
    webRedirectUris: uriList('The complete new list of Web platform'),
    spaRedirectUris: uriList('The complete new list of single-page application'),
    publicClientRedirectUris: uriList('The complete new list of mobile/desktop'),
    identifierUris: z
      .array(z.string().min(1))
      .optional()
      .describe('The complete new list of Application ID URIs (api://… or a verified-domain URL).'),
  });

  /** Only what the caller set, as Graph's PATCH body; null when nothing was. */
  function updateBody(args: z.infer<typeof updateSchema>): Record<string, unknown> | null {
    const body: Record<string, unknown> = {};
    if (args.displayName !== undefined) body.displayName = args.displayName;
    if (args.description !== undefined) body.description = args.description;
    if (args.webRedirectUris !== undefined) body.web = { redirectUris: args.webRedirectUris };
    if (args.spaRedirectUris !== undefined) body.spa = { redirectUris: args.spaRedirectUris };
    if (args.publicClientRedirectUris !== undefined) {
      body.publicClient = { redirectUris: args.publicClientRedirectUris };
    }
    if (args.identifierUris !== undefined) body.identifierUris = args.identifierUris;
    return Object.keys(body).length > 0 ? body : null;
  }

  server.registerTool(
    'entra_update_application_preview',
    {
      title: 'Entra Developer · Act — Preview changing an app registration',
      description:
        'Show the user a card to confirm or cancel changing an app registration’s display ' +
        'name, description, redirect URIs (per platform) or identifier URIs. Each list given ' +
        'REPLACES the current one, so pass the complete list you want; omit what should stay. ' +
        'The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: updateSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const body = updateBody(args);
      if (!body) return errText('Nothing to change: give a new name, description or URI list.');
      const bad = badRedirects(
        args.webRedirectUris,
        args.spaRedirectUris,
        args.publicClientRedirectUris
      );
      if (bad.length > 0) {
        return errText(
          `Redirect URIs must be absolute https URLs (http only for localhost): ${bad.join(', ')}`
        );
      }
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const fields: { label: string; value: string; oldValue?: string }[] = [];
      const listField = (label: string, next: string[] | undefined, current: string[]) => {
        if (next === undefined) return;
        fields.push({
          label,
          value: next.length > 0 ? next.join('\n') : '(none)',
          oldValue: current.length > 0 ? current.join('\n') : '(none)',
        });
      };
      if (args.displayName !== undefined) {
        fields.push({
          label: 'Display name',
          value: args.displayName,
          oldValue: str(app.displayName),
        });
      }
      if (args.description !== undefined) {
        fields.push({
          label: 'Description',
          value: args.description || '(none)',
          oldValue: str(app.description) || '(none)',
        });
      }
      listField('Web redirect URIs', args.webRedirectUris, strings(rec(app.web).redirectUris));
      listField(
        'Single-page app redirect URIs',
        args.spaRedirectUris,
        strings(rec(app.spa).redirectUris)
      );
      listField(
        'Mobile/desktop redirect URIs',
        args.publicClientRedirectUris,
        strings(rec(app.publicClient).redirectUris)
      );
      listField('Identifier URIs', args.identifierUris, strings(app.identifierUris));
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Change application',
        tone: 'caution',
        title: `Change ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        fields,
        confirmTool: 'entra_update_application_confirm',
        confirmLabel: 'Apply changes',
        confirmArgs: { ...args, application: str(app.id) },
      });
    }
  );

  server.registerTool(
    'entra_update_application_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed app registration change',
      description:
        'Apply the app registration changes the user confirmed on the preview card.' +
        confirmGuard('entra_update_application_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: updateSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const body = updateBody(args);
      if (!body) return errText('Nothing to change.');
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const patched = await entraRequest(
        context,
        access,
        'PATCH',
        `/applications/${str(app.id)}`,
        body
      );
      if (!patched.ok) return errText(`Could not change ${str(app.displayName)}: ${patched.error}`);
      const after = await entraRequest(
        context,
        access,
        'GET',
        `/applications/${str(app.id)}?${APPLICATION_SELECT}`
      );
      const lines = [`Changed app registration "${str(app.displayName)}".`];
      if (after.ok) lines.push(...describeApplication(after.body).slice(1));
      return textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------
  // Give an existing registration its enterprise application.
  // -------------------------------------------------------------------

  const enterpriseSchema = z.object({ application: applicationRefField });

  server.registerTool(
    'entra_create_enterprise_application_preview',
    {
      title: 'Entra Developer · Act — Preview creating an enterprise application',
      description:
        'Show the user a card to confirm or cancel creating the enterprise application ' +
        '(service principal) for an app registration that has none in this directory — ' +
        'which is what users and groups get assigned app roles on. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: enterpriseSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const existing = await servicePrincipalForAppId(context, access, str(app.appId));
      if (!existing.ok) return errText(existing.error);
      if (existing.value) {
        return errText(
          `${str(app.displayName)} already has an enterprise application (object id ` +
            `${str(existing.value.id)}); entra_get_enterprise_application shows it.`
        );
      }
      const roles = appRolesOf(app);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Create enterprise application',
        tone: 'positive',
        title: `Create enterprise application for ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        fields: [
          { label: 'Sign-in audience', value: str(app.signInAudience) || 'unknown' },
          { label: 'App roles it will carry', value: String(roles.length) },
        ],
        confirmTool: 'entra_create_enterprise_application_confirm',
        confirmLabel: 'Create enterprise application',
        confirmArgs: { application: str(app.id) },
      });
    }
  );

  server.registerTool(
    'entra_create_enterprise_application_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed enterprise application creation',
      description:
        'Create the enterprise application the user confirmed on the preview card.' +
        confirmGuard('entra_create_enterprise_application_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: enterpriseSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const created = await entraRequest(context, access, 'POST', '/servicePrincipals', {
        appId: str(app.appId),
      });
      if (!created.ok) {
        return errText(
          `Could not create the enterprise application for ${str(app.displayName)}: ${created.error}`
        );
      }
      return textResult(
        `Created the enterprise application for "${str(app.displayName)}" — object id ` +
          `${str(created.body.id)}, appId ${str(app.appId)}. Assign users and groups to its ` +
          'roles with entra_assign_app_role_preview.'
      );
    }
  );

  // -------------------------------------------------------------------
  // Add app roles.
  // -------------------------------------------------------------------

  const addRolesSchema = z.object({
    application: applicationRefField,
    appRoles: z.array(appRoleInput).min(1).max(50).describe('The roles to add.'),
  });

  server.registerTool(
    'entra_add_app_roles_preview',
    {
      title: 'Entra Developer · Act — Preview adding app roles',
      description:
        'Show the user a card to confirm or cancel adding app roles to an app registration ' +
        '(existing roles are kept). Each role needs a display name, a unique claim value and ' +
        'a description; roles for users and groups are the default. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: addRolesSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const existing = appRolesOf(app);
      const duplicates = duplicateValues(existing, args.appRoles);
      if (duplicates.length > 0) {
        return errText(
          `App role values must be unique within the application; already taken or repeated: ${duplicates.join(', ')}`
        );
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Add app roles',
        tone: 'positive',
        title: `Add ${args.appRoles.length} app role${args.appRoles.length === 1 ? '' : 's'} to ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        groupLists: [
          { label: 'Roles to add', groups: roleLines(args.appRoles), tone: 'add' },
          ...(existing.length > 0
            ? [
                {
                  label: 'Roles it already has',
                  groups: existing.map((r) => `${r.displayName} [${r.value}]`),
                  tone: 'muted' as const,
                },
              ]
            : []),
        ],
        confirmTool: 'entra_add_app_roles_confirm',
        confirmLabel: 'Add roles',
        confirmArgs: { ...args, application: str(app.id) },
      });
    }
  );

  server.registerTool(
    'entra_add_app_roles_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed app role addition',
      description:
        'Add the app roles the user confirmed on the preview card.' +
        confirmGuard('entra_add_app_roles_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: addRolesSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const existing = appRolesOf(app);
      const duplicates = duplicateValues(existing, args.appRoles);
      if (duplicates.length > 0) {
        return errText(`App role values already taken or repeated: ${duplicates.join(', ')}`);
      }
      // appRoles is replaced wholesale on PATCH, so the current roles ride
      // along untouched — as Graph returned them, not re-shaped.
      const merged = [
        ...(Array.isArray(app.appRoles) ? app.appRoles : []),
        ...toGraphRoles(args.appRoles),
      ];
      const patched = await entraRequest(context, access, 'PATCH', `/applications/${str(app.id)}`, {
        appRoles: merged,
      });
      if (!patched.ok) {
        return errText(`Could not add app roles to ${str(app.displayName)}: ${patched.error}`);
      }
      const after = await entraRequest(
        context,
        access,
        'GET',
        `/applications/${str(app.id)}?$select=id,appId,displayName,appRoles`
      );
      const roles = after.ok ? appRolesOf(after.body) : [];
      return textResult(
        [
          `Added ${args.appRoles.length} app role${args.appRoles.length === 1 ? '' : 's'} to "${str(app.displayName)}".` +
            ' The enterprise application carries them within a few minutes.',
          ...(roles.length > 0
            ? [`App roles now (${roles.length}):`, ...roles.map((r) => `  • ${describeRole(r)}`)]
            : []),
        ].join('\n')
      );
    }
  );

  // -------------------------------------------------------------------
  // Remove an app role (disable, then drop).
  // -------------------------------------------------------------------

  const removeRoleSchema = z.object({
    application: applicationRefField,
    appRole: z.string().min(1).describe('The role: its id, claim value or display name.'),
  });

  server.registerTool(
    'entra_remove_app_role_preview',
    {
      title: 'Entra Developer · Act — Preview removing an app role',
      description:
        'Show the user a card to confirm or cancel removing an app role from an app ' +
        'registration. Entra requires a role to be disabled before it is removed; the confirm ' +
        'does both. Users and groups holding the role lose it. The user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: removeRoleSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const role = findAppRole(appRolesOf(app), args.appRole);
      if (!role.ok) return errText(role.error);
      const fields = [{ label: 'Role', value: describeRole(role.value) }];
      const sp = await servicePrincipalForAppId(context, access, str(app.appId));
      if (sp.ok && sp.value) {
        const assigned = await listAssignments(context, access, str(sp.value.id));
        if (assigned.ok) {
          const holders = assigned.value.assignments.filter((a) => a.appRoleId === role.value.id);
          fields.push({
            label: 'Currently assigned',
            value:
              holders.length === 0
                ? 'No one'
                : holders.map((h) => h.principalDisplayName || h.principalId).join(', ') +
                  (assigned.value.truncated ? ' (and possibly more)' : ''),
          });
        }
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Remove app role',
        tone: 'caution',
        title: `Remove ${role.value.displayName} from ${str(app.displayName)}`,
        subtitle: `Microsoft Entra · app registration ${str(app.appId)}`,
        person: { name: str(app.displayName), detail: `Application (client) id ${str(app.appId)}` },
        fields,
        confirmTool: 'entra_remove_app_role_confirm',
        confirmLabel: 'Remove role',
        confirmArgs: { application: str(app.id), appRole: role.value.id },
      });
    }
  );

  server.registerTool(
    'entra_remove_app_role_confirm',
    {
      title: 'Entra Developer · Act — Execute a confirmed app role removal',
      description:
        'Disable and remove the app role the user confirmed on the preview card.' +
        confirmGuard('entra_remove_app_role_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: removeRoleSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await findApplication(context, access, args.application);
      if (!found.ok) return errText(found.error);
      const app = found.value;
      const current = Array.isArray(app.appRoles) ? app.appRoles.map(rec) : [];
      const role = findAppRole(appRolesOf(app), args.appRole);
      if (!role.ok) return errText(role.error);
      const targetId = role.value.id;
      const path = `/applications/${str(app.id)}`;
      if (role.value.isEnabled) {
        const disabled = await entraRequest(context, access, 'PATCH', path, {
          appRoles: current.map((r) => (str(r.id) === targetId ? { ...r, isEnabled: false } : r)),
        });
        if (!disabled.ok) {
          return errText(`Could not disable ${role.value.displayName}: ${disabled.error}`);
        }
      }
      const removed = await entraRequest(context, access, 'PATCH', path, {
        appRoles: current.filter((r) => str(r.id) !== targetId),
      });
      if (!removed.ok) {
        return errText(
          `Disabled ${role.value.displayName} but could not remove it: ${removed.error}. ` +
            'Run the preview again to retry the removal.'
        );
      }
      return textResult(
        `Removed app role "${role.value.displayName}" [${role.value.value}] from "${str(app.displayName)}".`
      );
    }
  );
}
