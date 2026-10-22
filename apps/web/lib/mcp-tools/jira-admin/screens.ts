/**
 * Screens: jira_admin_get_space_screens reads the screens a space shows its
 * work types on — each tab's fields, and which other spaces show the same
 * screen — and jira_admin_propose_screen_changes proposes changes to one
 * screen as a change request the person applies from Renkei's review page
 * (lib/jira-admin/screen-changes.ts). Nothing changes in Jira here.
 *
 * Reach first: a screen is shown by every space whose schemes lead to it,
 * so a screen shown by more than one space is named with those spaces and
 * refused unless the request says `sharedScreens: true`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import {
  errText,
  jiraAdminGet,
  rec,
  records,
  str,
  textResult,
  type JiraAdminAccess,
} from './client';
import { reviewPrefix } from './review-link';
import {
  CHANGE_REQUEST_TTL_HOURS,
  cancelChangeRequest,
  createChangeRequest,
} from '@/lib/jira-admin/change-requests';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import {
  FIELD_POSITIONS,
  SCREEN_CHANGES_KIND,
  readScreenTabs,
  screenChangesTitle,
  type ScreenChangesPayload,
  type ScreenOperation,
  type ScreenTabFields,
} from '@/lib/jira-admin/screen-changes';
import { otherSpacesOnScreens, readSpaceScreens } from '@/lib/jira-admin/space-screens';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const MAX_OPERATIONS = 40;

/** A screen by id or exact name, as `/screens` lists it. */
async function findScreen(
  context: MCPToolContext,
  access: JiraAdminAccess,
  reference: string
): Promise<{ ok: true; screen: { id: string; name: string } } | { ok: false; reason: string }> {
  const byId = /^\d+$/.test(reference);
  const result = await jiraAdminGet(
    context,
    access,
    byId
      ? `/rest/api/3/screens?id=${encodeURIComponent(reference)}`
      : `/rest/api/3/screens?maxResults=100&queryString=${encodeURIComponent(reference)}`
  );
  if (!result.ok) return { ok: false, reason: result.error };
  const screens = records(result.body).map((screen) => ({
    id: str(screen.id),
    name: str(screen.name),
  }));
  if (byId) {
    const match = screens.find((screen) => screen.id === reference);
    return match
      ? { ok: true, screen: match }
      : { ok: false, reason: `No screen has the id ${reference}.` };
  }
  const exact = screens.filter((screen) => screen.name.toLowerCase() === reference.toLowerCase());
  if (exact.length === 1 && exact[0]) return { ok: true, screen: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      reason:
        `${exact.length} screens are named “${reference}” — pass the id of the one you mean: ` +
        exact.map((screen) => screen.id).join(', '),
    };
  }
  const close = screens.slice(0, 5).map((screen) => `${screen.name} (${screen.id})`);
  return {
    ok: false,
    reason:
      `No screen is named “${reference}”.` +
      (close.length > 0 ? ` Closest: ${close.join(', ')}.` : ''),
  };
}

type Named = { id: string; name: string };

/** One of `candidates` by id or exact name; several of the name is refused. */
function pick(
  candidates: Named[],
  reference: string
): { ok: true; item: Named } | { ok: false; reason: string } {
  const wanted = reference.trim().toLowerCase();
  const byId = candidates.find((candidate) => candidate.id.toLowerCase() === wanted);
  if (byId) return { ok: true, item: byId };
  const named = candidates.filter((candidate) => candidate.name.trim().toLowerCase() === wanted);
  if (named.length === 1 && named[0]) return { ok: true, item: named[0] };
  if (named.length > 1) {
    return {
      ok: false,
      reason:
        `${named.length} fields are named “${reference}” — pass the id of the one you mean: ` +
        named.map((candidate) => candidate.id).join(', '),
    };
  }
  return { ok: false, reason: `No field “${reference}”` };
}

export async function registerScreenTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_get_space_screens',
    {
      title: 'Jira Admin · Read — A space’s screens',
      description:
        'The screens a company-managed space shows its work types on (or the ones you name): ' +
        'each screen’s id, when the space shows it (creating, editing, viewing), its tabs with ' +
        'their fields in order, and which other spaces show the same screen. Use the ids with ' +
        'jira_admin_propose_screen_changes.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        space: z.string().min(1).describe('The space (project) key, e.g. OPS'),
        workTypes: z
          .array(z.string().min(1))
          .max(30)
          .describe('Only these work types, e.g. Bug, Task — default every one in the space')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const spaceRef = text(args.space).toUpperCase();
      if (!spaceRef) return errText('space is required');
      const project = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/${encodeURIComponent(spaceRef)}`
      );
      if (!project.ok) return errText(`Space ${spaceRef}: ${project.error}`);
      const spaceRecord = rec(project.body);
      const space = { id: str(spaceRecord.id), key: str(spaceRecord.key) || spaceRef };
      if (spaceRecord.simplified === true || spaceRecord.style === 'next-gen') {
        return errText(`${space.key} is team-managed: its screens live inside the space.`);
      }
      const spaceTypes = records(spaceRecord.issueTypes).map((type) => ({
        id: str(type.id),
        name: str(type.name),
      }));
      const wanted = Array.isArray(args.workTypes) ? args.workTypes.map(text).filter(Boolean) : [];
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
      const read = await readSpaceScreens(context, access, {
        spaceId: space.id,
        issueTypeIds: (issueTypes.length > 0 ? issueTypes : spaceTypes).map((type) => type.id),
      });
      if (!read.ok) return errText(`${space.key}’s screens: ${read.reason}`);
      const sharing = await otherSpacesOnScreens(
        context,
        access,
        read.screens.map((screen) => screen.id),
        space.id
      );
      const lines: string[] = [
        `${space.key} shows ${read.screens.length} screen${read.screens.length === 1 ? '' : 's'}:`,
      ];
      for (const screen of read.screens) {
        const tabs = await readScreenTabs(context, access, screen.id);
        const found = sharing?.get(screen.id);
        const shared = !sharing
          ? 'possibly other spaces too — Jira would not say'
          : found && found.spaces.length > 0
            ? `also shown by ${found.spaces.slice(0, 8).join(', ')}${found.more || found.spaces.length > 8 ? ' and more' : ''}`
            : found?.more
              ? 'possibly other spaces too'
              : `${space.key}’s alone`;
        lines.push(
          '',
          `${screen.name} — id ${screen.id} — ${screen.uses.join(', ') || 'unused'} — ${shared}`
        );
        if (!tabs.ok) {
          lines.push(`  ${tabs.error}`);
          continue;
        }
        for (const tab of tabs.tabs) {
          lines.push(
            `  Tab “${tab.name}” (id ${tab.id}): ` +
              (tab.fields.length > 0
                ? tab.fields.map((field) => `${field.name} (${field.id})`).join(', ')
                : 'no fields')
          );
        }
      }
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'one block per screen, its tabs and fields as a list; keep the ids, they are what ' +
            'jira_admin_propose_screen_changes takes'
        )
      );
    }
  );

  server.registerTool(
    'jira_admin_propose_screen_changes',
    {
      title: 'Jira Admin · Act — Propose changes to a screen',
      description:
        'Propose changes to one screen (by id or exact name — jira_admin_get_space_screens ' +
        'lists a space’s): fields put on a tab (add), taken off it (remove — the field and its ' +
        'values stay, it is just no longer shown here), moved on their tab (move: first, last, ' +
        'earlier, later), tabs added (addTabs) or renamed (renameTabs), and the screen renamed ' +
        '(rename). A field is named by id or exact name; a tab by name, default the first. A ' +
        'screen shown by more than one space is named with them, and only changed with ' +
        'sharedScreens: true. Nothing changes in Jira: this saves a change request, and the ' +
        'user applies it from the Renkei review page linked in the result (it expires in ' +
        `${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        screen: z.string().min(1).describe('The screen’s id or exact name'),
        add: z
          .array(
            z.object({
              field: z.string().min(1).describe('A field’s id or exact name'),
              tab: z
                .string()
                .max(255)
                .describe('The tab to put it on — default the first')
                .optional(),
            })
          )
          .max(MAX_OPERATIONS)
          .describe('Fields to put on the screen')
          .optional(),
        remove: z
          .array(z.string().min(1))
          .max(MAX_OPERATIONS)
          .describe('Fields to take off the screen, by id or exact name')
          .optional(),
        move: z
          .array(
            z.object({
              field: z.string().min(1).describe('A field on the screen, by id or exact name'),
              position: z.enum(FIELD_POSITIONS).describe('Where on its tab'),
            })
          )
          .max(MAX_OPERATIONS)
          .describe('Fields to move on their tab')
          .optional(),
        addTabs: z.array(z.string().min(1).max(255)).max(10).describe('Tabs to add').optional(),
        renameTabs: z
          .array(z.object({ from: z.string().min(1).max(255), to: z.string().min(1).max(255) }))
          .max(10)
          .describe('Tabs to rename')
          .optional(),
        rename: z.string().min(1).max(255).describe('A new name for the screen').optional(),
        sharedScreens: z
          .boolean()
          .describe('Also go ahead when other spaces show the screen (default false)')
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

      const screenRef = text(args.screen);
      if (!screenRef) return errText('screen is required');
      const found = await findScreen(context, access, screenRef);
      if (!found.ok) return errText(found.reason);
      const { screen } = found;
      const notes: string[] = [];

      // The screen as it is, and who shows it.
      const read = await readScreenTabs(context, access, screen.id);
      if (!read.ok) return errText(`The screen “${screen.name}”: ${read.error}`);
      const tabs: ScreenTabFields[] = read.tabs.map((tab) => ({
        ...tab,
        fields: [...tab.fields],
      }));
      const sharing = await otherSpacesOnScreens(context, access, [screen.id], '');
      const showing = sharing?.get(screen.id);
      const spaces = showing?.spaces ?? [];
      const moreSpaces = showing ? showing.more : true;
      if ((spaces.length > 1 || moreSpaces) && args.sharedScreens !== true) {
        return errText(
          spaces.length > 0
            ? `The screen “${screen.name}” is shown by ${spaces.slice(0, 8).join(', ')}` +
                `${moreSpaces || spaces.length > 8 ? ' and more' : ''}, and every one of them ` +
                'sees these changes. Pass sharedScreens: true to go ahead.'
            : `Jira would not say which spaces show “${screen.name}”, so Renkei cannot tell how ` +
                'far these changes reach. Pass sharedScreens: true to go ahead anyway.'
        );
      }

      const tabNamed = (name: string) =>
        tabs.find((tab) => tab.name.toLowerCase() === name.toLowerCase());
      const onScreen = (): Named[] =>
        tabs.flatMap((tab) => tab.fields.map((field) => ({ id: field.id, name: field.name })));
      const operations: ScreenOperation[] = [];

      // Adds come from what the screen does not show yet.
      const adds = Array.isArray(args.add) ? args.add : [];
      if (adds.length > 0) {
        const available = await jiraAdminGet(
          context,
          access,
          `/rest/api/3/screens/${encodeURIComponent(screen.id)}/availableFields`
        );
        if (!available.ok) return errText(`The fields it could show: ${available.error}`);
        const candidates: Named[] = records(available.body).map((field) => ({
          id: str(field.id),
          name: str(field.name) || str(field.id),
        }));
        for (const item of adds) {
          const entry = rec(item);
          const fieldRef = text(entry.field);
          const tabRef = text(entry.tab);
          const tab = tabRef ? tabNamed(tabRef) : tabs[0];
          if (!tab) {
            return errText(
              tabRef
                ? `“${screen.name}” has no tab “${tabRef}”. Its tabs: ${tabs.map((t) => t.name).join(', ')}.`
                : `“${screen.name}” has no tabs to put a field on; pass addTabs first.`
            );
          }
          const held = pick(onScreen(), fieldRef);
          if (held.ok) {
            notes.push(`“${held.item.name}” is on the screen already.`);
            continue;
          }
          const picked = pick(candidates, fieldRef);
          if (!picked.ok) {
            return errText(
              picked.reason.startsWith('No field')
                ? `${picked.reason} can be put on “${screen.name}” — check the name, or ` +
                    'jira_admin_list_fields for custom fields.'
                : picked.reason
            );
          }
          operations.push({
            op: 'add_field',
            fieldId: picked.item.id,
            fieldName: picked.item.name,
            tabId: tab.id,
            tabName: tab.name,
          });
          tab.fields.push({ id: picked.item.id, name: picked.item.name });
        }
      }

      for (const fieldRef of Array.isArray(args.remove) ? args.remove.map(text) : []) {
        if (!fieldRef) continue;
        const picked = pick(onScreen(), fieldRef);
        if (!picked.ok) {
          if (picked.reason.startsWith('No field')) {
            notes.push(`“${fieldRef}” is not on the screen, so there is nothing to take off.`);
            continue;
          }
          return errText(picked.reason);
        }
        const tab = tabs.find((candidate) => candidate.fields.some((f) => f.id === picked.item.id));
        if (!tab) continue;
        operations.push({
          op: 'remove_field',
          fieldId: picked.item.id,
          fieldName: picked.item.name,
          tabId: tab.id,
          tabName: tab.name,
        });
        tab.fields = tab.fields.filter((f) => f.id !== picked.item.id);
      }

      for (const item of Array.isArray(args.move) ? args.move : []) {
        const entry = rec(item);
        const fieldRef = text(entry.field);
        const position = text(entry.position);
        if (!fieldRef || !FIELD_POSITIONS.some((p) => p === position)) continue;
        const picked = pick(onScreen(), fieldRef);
        if (!picked.ok) {
          return errText(
            picked.reason.startsWith('No field')
              ? `${picked.reason} is on “${screen.name}” to move.`
              : picked.reason
          );
        }
        const tab = tabs.find((candidate) => candidate.fields.some((f) => f.id === picked.item.id));
        if (!tab) continue;
        operations.push({
          op: 'move_field',
          fieldId: picked.item.id,
          fieldName: picked.item.name,
          tabId: tab.id,
          tabName: tab.name,
          position:
            position === 'first'
              ? 'first'
              : position === 'last'
                ? 'last'
                : position === 'earlier'
                  ? 'earlier'
                  : 'later',
        });
      }

      for (const name of Array.isArray(args.addTabs) ? args.addTabs.map(text) : []) {
        if (!name) continue;
        if (tabNamed(name)) {
          notes.push(`“${screen.name}” has a tab “${name}” already.`);
          continue;
        }
        operations.push({ op: 'add_tab', name });
        tabs.push({ id: '', name, fields: [] });
      }

      for (const item of Array.isArray(args.renameTabs) ? args.renameTabs : []) {
        const entry = rec(item);
        const from = text(entry.from);
        const to = text(entry.to);
        if (!from || !to) continue;
        const tab = tabNamed(from);
        if (!tab) {
          return errText(
            `“${screen.name}” has no tab “${from}” to rename. Its tabs: ${tabs.map((t) => t.name).join(', ')}.`
          );
        }
        if (!tab.id)
          return errText(
            `The tab “${from}” is one this request adds; name it as you want it in addTabs.`
          );
        operations.push({ op: 'rename_tab', tabId: tab.id, from: tab.name, to });
        tab.name = to;
      }

      const rename = text(args.rename);
      if (rename && rename.toLowerCase() !== screen.name.toLowerCase()) {
        operations.push({ op: 'rename_screen', from: screen.name, to: rename });
      } else if (rename) {
        notes.push('The screen has that name already.');
      }

      if (operations.length === 0) {
        return errText(
          `Nothing to do on “${screen.name}”.` + (notes.length > 0 ? ` ${notes.join(' ')}` : '')
        );
      }
      if (operations.length > MAX_OPERATIONS) {
        return errText(
          `That is ${operations.length} changes; propose at most ${MAX_OPERATIONS} at a time.`
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
      const db = dbResult.val;
      const payload: ScreenChangesPayload = { screen, spaces, moreSpaces, operations };
      const reason = text(args.reason);
      const change = await createChangeRequest(db, {
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        kind: SCREEN_CHANGES_KIND,
        title: screenChangesTitle(payload),
        reason: reason || undefined,
        payload,
      });

      const replaces = text(args.replaces);
      if (replaces) {
        const cancelled = await cancelChangeRequest(db, context.subject, replaces);
        notes.push(
          cancelled
            ? `Cancelled the request it replaces (${replaces}).`
            : `Did not cancel ${replaces}: it is not a pending request of this user’s.`
        );
      }

      const link = `${reviewPrefix(context)}${change.id}`;
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
