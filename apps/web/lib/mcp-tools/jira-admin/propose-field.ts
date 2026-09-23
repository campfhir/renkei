/**
 * jira_admin_propose_space_field — a custom field on a space's screens,
 * proposed as a change request the person applies from Renkei's review
 * page (lib/jira-admin/space-field.ts). Nothing changes in Jira here.
 *
 * It reuses before it creates: a field named as asked, of the type asked,
 * is used rather than a second one made. The space gets a context of its
 * own only when it needs one — for options of its own, or because no
 * context covers it — and options already offered are not asked for twice.
 * Options on a context every space shares are refused, not quietly
 * changed: that is jira_admin_propose_option_changes' job, where the
 * review page says "every space".
 *
 * And it names reach before anyone applies: every screen the field would
 * go on that other spaces show too, with those spaces, refused unless the
 * request says `sharedScreens: true`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, jiraAdminGet, jiraAdminPages, rec, records, str } from './client';
import { fieldTypeLabel, findCustomField } from './fields';
import { reviewPrefix } from './review-link';
import {
  CHANGE_REQUEST_TTL_HOURS,
  cancelChangeRequest,
  createChangeRequest,
} from '@/lib/jira-admin/change-requests';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import { readContextOptions } from '@/lib/jira-admin/field-options';
import {
  FIELD_TYPES,
  FIELD_TYPE_NAMES,
  MAX_FIELD_OPTIONS,
  SPACE_FIELD_KIND,
  fieldTypeNameOf,
  isFieldTypeName,
  spaceFieldTitle,
  type AddToScreenOperation,
  type FieldTypeName,
  type SpaceFieldOperation,
  type SpaceFieldPayload,
} from '@/lib/jira-admin/space-field';
import {
  otherSpacesOnScreens,
  readSpaceScreens,
  type ScreenSharing,
} from '@/lib/jira-admin/space-screens';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Values once each, ignoring case, in the order given. */
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function registerProposeFieldTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_propose_space_field',
    {
      title: 'Jira Admin · Act — Propose a field for a space',
      description:
        'Propose putting a custom field on a company-managed space’s screens: an existing field ' +
        '(field: its id or exact name) or a new one (name and type) — a field already named ' +
        'that, of that type, is reused rather than created twice. The space gets a context of ' +
        'its own for the field when it needs one, offering the options you list (select ' +
        'lists, radio buttons, checkboxes). The field goes on every screen the space uses for ' +
        'its work types (or the ones you name), on the tab you name or each screen’s first. ' +
        'Screens other spaces show too are named, and are only used with sharedScreens: true — ' +
        'the field appears in those spaces as well. To change an existing field’s options, use ' +
        'jira_admin_propose_option_changes. Nothing changes in Jira: this saves a change ' +
        'request, and the user applies it from the Renkei review page linked in the result (it ' +
        `expires in ${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        space: z.string().min(1).describe('The space (project) key, e.g. OPS'),
        field: z
          .string()
          .describe('An existing custom field’s id or exact name — or pass name and type')
          .optional(),
        name: z
          .string()
          .max(255)
          .describe(
            'A new field’s name. A field already named this, of this type, is used instead.'
          )
          .optional(),
        type: z.enum(FIELD_TYPE_NAMES).describe('A new field’s type').optional(),
        description: z.string().max(1000).describe('A new field’s description').optional(),
        options: z
          .array(z.string().min(1).max(255))
          .max(MAX_FIELD_OPTIONS)
          .describe('For a select list, radio buttons or checkboxes: what the space offers')
          .optional(),
        workTypes: z
          .array(z.string().min(1))
          .max(30)
          .describe('Only these work types, e.g. Bug, Task — default every one in the space')
          .optional(),
        tab: z
          .string()
          .max(255)
          .describe('The screen tab to put it on — default each screen’s first tab')
          .optional(),
        sharedScreens: z
          .boolean()
          .describe(
            'Also use screens other spaces show — the field appears there too (default false)'
          )
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

      const spaceRef = text(args.space).toUpperCase();
      const fieldRef = text(args.field);
      const newName = text(args.name);
      const typeArg = text(args.type);
      const tab = text(args.tab);
      const options = distinct(
        (Array.isArray(args.options) ? args.options.map(text) : []).filter(Boolean)
      );
      if (!spaceRef) return errText('space is required');
      if (Boolean(fieldRef) === Boolean(newName)) {
        return errText('Pass exactly one of field (an existing field) or name (a new one).');
      }
      if (newName && !isFieldTypeName(typeArg)) {
        return errText(`A new field needs a type: ${FIELD_TYPE_NAMES.join(', ')}.`);
      }
      const notes: string[] = [];

      // The space: company-managed, with the work types asked for.
      const project = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/${encodeURIComponent(spaceRef)}`
      );
      if (!project.ok) return errText(`Space ${spaceRef}: ${project.error}`);
      const spaceRecord = rec(project.body);
      const space = { id: str(spaceRecord.id), key: str(spaceRecord.key) || spaceRef };
      if (spaceRecord.simplified === true || spaceRecord.style === 'next-gen') {
        return errText(
          `${space.key} is team-managed: its fields live inside the space and are set up there, ` +
            'not with site custom fields.'
        );
      }
      const spaceTypes = records(spaceRecord.issueTypes).map((type) => ({
        id: str(type.id),
        name: str(type.name),
      }));
      const wanted = distinct(Array.isArray(args.workTypes) ? args.workTypes.map(text) : []);
      const chosen = wanted.map((name) =>
        spaceTypes.find((type) => type.name.toLowerCase() === name.toLowerCase())
      );
      const unknown = wanted.filter((_, index) => !chosen[index]);
      if (unknown.length > 0) {
        return errText(
          `${space.key} has no work type ${unknown.map((name) => `“${name}”`).join(', ')}. Its ` +
            `work types: ${spaceTypes.map((type) => type.name).join(', ')}.`
        );
      }
      const issueTypes = chosen.flatMap((type) => (type ? [type] : []));

      // The field: the one named, one already of this name and type, or a new one.
      let field: { id: string | null; name: string; typeLabel: string; type: FieldTypeName | null };
      if (fieldRef) {
        const found = await findCustomField(context, access, fieldRef);
        if (!found.ok) return errText(found.reason);
        if (found.field.isLocked === true) {
          return errText(
            `${str(found.field.name)} is managed by Jira or an app, so Renkei does not change it.`
          );
        }
        field = {
          id: str(found.field.id),
          name: str(found.field.name),
          typeLabel: fieldTypeLabel(found.field),
          type: fieldTypeNameOf(found.field),
        };
      } else {
        const type = isFieldTypeName(typeArg) ? typeArg : 'text';
        const search = await jiraAdminGet(
          context,
          access,
          `/rest/api/3/field/search?type=custom&maxResults=50&query=${encodeURIComponent(newName)}`
        );
        if (!search.ok) return errText(`Looking for a field named “${newName}”: ${search.error}`);
        const named = records(search.body).filter(
          (candidate) => str(candidate.name).trim().toLowerCase() === newName.toLowerCase()
        );
        if (named.length > 1) {
          return errText(
            `${named.length} custom fields are named “${newName}” already — pass field with the ` +
              `id of the one you mean: ${named.map((candidate) => `${str(candidate.id)} (${fieldTypeLabel(candidate)})`).join(', ')}.`
          );
        }
        const existing = named[0];
        if (existing && fieldTypeNameOf(existing) !== type) {
          return errText(
            `A custom field named “${str(existing.name)}” exists already (${str(existing.id)}), ` +
              `a ${fieldTypeLabel(existing)}. Use it (field: ${str(existing.id)}), or choose ` +
              'another name — two fields of one name confuse everyone who searches.'
          );
        }
        if (existing) {
          if (existing.isLocked === true) {
            return errText(
              `${str(existing.name)} is managed by Jira or an app, so Renkei does not change it.`
            );
          }
          notes.push(
            `A ${fieldTypeLabel(existing)} named “${str(existing.name)}” exists already ` +
              `(${str(existing.id)}), so it is used rather than a second one created.`
          );
          field = {
            id: str(existing.id),
            name: str(existing.name),
            typeLabel: fieldTypeLabel(existing),
            type,
          };
        } else {
          field = { id: null, name: newName, typeLabel: FIELD_TYPES[type].label, type };
        }
      }
      const takesOptions = field.type !== null && FIELD_TYPES[field.type].options;
      if (options.length > 0 && !takesOptions) {
        return errText(
          `“${field.name}” is a ${field.typeLabel}; options are set here only on select lists, ` +
            'radio buttons and checkboxes.'
        );
      }

      const operations: SpaceFieldOperation[] = [];
      if (!field.id) {
        operations.push({
          op: 'create_field',
          name: field.name,
          description: text(args.description) || null,
          type: field.type ?? 'text',
        });
      }

      // Its context in this space: reuse the space's own, never change one
      // every space shares, and add one only when needed.
      const contextName = `${field.name} for ${space.key}`;
      if (!field.id) {
        operations.push({ op: 'add_context', name: contextName, issueTypes, options });
      } else {
        const base = `/rest/api/3/field/${encodeURIComponent(field.id)}/context`;
        const [contexts, mappings] = await Promise.all([
          jiraAdminPages(context, access, base),
          jiraAdminPages(context, access, `${base}/projectmapping`, 20),
        ]);
        if (!contexts.ok) return errText(`Reading its contexts: ${contexts.error}`);
        if (!mappings.ok) return errText(`Reading its contexts: ${mappings.error}`);
        const ownId = str(
          mappings.values.find(
            (mapping) => mapping.isGlobalContext !== true && str(mapping.projectId) === space.id
          )?.contextId
        );
        if (!ownId && mappings.truncated) {
          return errText(
            `“${field.name}” is mapped to too many spaces for Renkei to tell whether ` +
              `${space.key} has a context of its own; set it up in Jira.`
          );
        }
        const own = contexts.values.find((ctx) => str(ctx.id) === ownId);
        const global = contexts.values.find((ctx) => ctx.isGlobalContext === true);
        if (ownId) {
          if (options.length > 0) {
            const live = await readContextOptions(context, access, field.id, ownId);
            if (!live.ok) return errText(`Reading its options in ${space.key}: ${live.error}`);
            const top = live.options.filter((option) => option.parentId === null);
            const same = (value: string) =>
              top.find((option) => option.value.trim().toLowerCase() === value.toLowerCase());
            const disabled = options.filter((value) => same(value)?.disabled === true);
            if (disabled.length > 0) {
              return errText(
                `${disabled.map((value) => `“${value}”`).join(', ')} ${disabled.length === 1 ? 'is' : 'are'} in ` +
                  `${space.key}’s context already, disabled — enable ${disabled.length === 1 ? 'it' : 'them'} with ` +
                  'jira_admin_propose_option_changes.'
              );
            }
            const missing = options.filter((value) => !same(value));
            if (missing.length < options.length) {
              notes.push(
                `${options.length - missing.length} of those options ${space.key} offers already.`
              );
            }
            if (missing.length > 0) {
              operations.push({
                op: 'add_options',
                contextId: ownId,
                contextName: str(own?.name) || contextName,
                options: missing,
              });
            }
          }
        } else if (global) {
          if (options.length > 0) {
            return errText(
              `“${field.name}” has a context every space shares (“${str(global.name)}”), and ` +
                `${space.key} has none of its own, so its options are the same in every space. ` +
                'Change them with jira_admin_propose_option_changes (the review page will say ' +
                'every space), or leave options out to only put the field on the screens.'
            );
          }
        } else {
          operations.push({ op: 'add_context', name: contextName, issueTypes, options });
        }
      }

      // Its screens: every one the space uses for these work types.
      const read = await readSpaceScreens(context, access, {
        spaceId: space.id,
        issueTypeIds: (issueTypes.length > 0 ? issueTypes : spaceTypes).map((type) => type.id),
      });
      if (!read.ok) return errText(`${space.key}’s screens: ${read.reason}`);
      let screens = read.screens;
      if (field.id) {
        const holding = await jiraAdminPages(
          context,
          access,
          `/rest/api/3/field/${encodeURIComponent(field.id)}/screens`
        );
        if (!holding.ok) return errText(`Which screens it is on: ${holding.error}`);
        const on = new Set(holding.values.map((screen) => str(screen.id)));
        const already = screens.filter((screen) => on.has(screen.id));
        if (already.length > 0) {
          notes.push(`It is on ${already.map((screen) => `“${screen.name}”`).join(', ')} already.`);
        }
        screens = screens.filter((screen) => !on.has(screen.id));
      }
      const empty = screens.find((screen) => screen.tabs.length === 0);
      if (empty) return errText(`The screen “${empty.name}” has no tabs to put a field on.`);

      const sharing: Map<string, ScreenSharing> | null =
        screens.length > 0
          ? await otherSpacesOnScreens(
              context,
              access,
              screens.map((screen) => screen.id),
              space.id
            )
          : new Map();
      if (sharing === null && args.sharedScreens !== true) {
        return errText(
          `Jira would not say which other spaces show ${space.key}’s screens, so Renkei cannot ` +
            'tell whether the field would appear elsewhere too. Pass sharedScreens: true to go ' +
            'ahead anyway.'
        );
      }
      const shared = screens.filter((screen) => {
        const found = sharing?.get(screen.id);
        return !found || found.spaces.length > 0 || found.more;
      });
      if (sharing !== null && shared.length > 0 && args.sharedScreens !== true) {
        return errText(
          `Some of ${space.key}’s screens are shown by other spaces too, and the field would ` +
            'appear there as well: ' +
            shared
              .map((screen) => {
                const found = sharing.get(screen.id);
                const names = found?.spaces.slice(0, 8).join(', ') ?? '';
                const more = !found || found.more || found.spaces.length > 8;
                // No names but "more": too many schemes on the site to look through them all.
                if (!names) return `“${screen.name}” (possibly others; too many to check)`;
                return `“${screen.name}” (${names}${more ? ' and more' : ''})`;
              })
              .join('; ') +
            `. Pass sharedScreens: true to go ahead, or give ${space.key} screens of its own first.`
        );
      }
      for (const screen of screens) {
        const match = tab
          ? screen.tabs.find((candidate) => candidate.name.toLowerCase() === tab.toLowerCase())
          : undefined;
        const chosenTab = match ?? screen.tabs[0];
        if (!chosenTab) continue;
        const found = sharing?.get(screen.id);
        const operation: AddToScreenOperation = {
          op: 'add_to_screen',
          screenId: screen.id,
          screenName: screen.name,
          tabId: chosenTab.id,
          tabName: chosenTab.name,
          tabNote:
            tab && !match ? `It has no “${tab}” tab, so the field goes on its first tab.` : null,
          uses: screen.uses,
          sharedWith: found?.spaces ?? [],
          moreShared: found ? found.more : sharing === null,
        };
        operations.push(operation);
      }

      if (operations.length === 0) {
        return errText(
          `Nothing to do: “${field.name}” is on all of ${space.key}’s screens for those work ` +
            'types already' +
            (options.length > 0 ? `, and ${space.key} offers those options already.` : '.')
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
      const db = dbResult.val;
      const payload: SpaceFieldPayload = {
        space,
        field: { id: field.id, name: field.name, typeLabel: field.typeLabel },
        operations,
      };
      const reason = text(args.reason);
      const change = await createChangeRequest(db, {
        tenantId: context.tenantId,
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        kind: SPACE_FIELD_KIND,
        title: spaceFieldTitle(payload),
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
      const { operations: described, reach } = describeChange(change);
      const lines = [
        'Proposed — nothing has changed in Jira yet.',
        '',
        ...operationLines(described),
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
