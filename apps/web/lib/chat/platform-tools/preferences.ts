/**
 * renkei_get_preferences and renkei_set_preferences — the person's own
 * preferences, read and changed from a chat: appearance (theme, the
 * line-number gutter), voice, the image model, the tours, chat archiving,
 * notifications, and the toolsets a new chat and a new code project start
 * with.
 *
 * Strictly the person's own: the subject is the turn's, never an input.
 * A change goes through the same reader and writer the Preferences page
 * uses (lib/preferences/documents.ts, tool-prefs.ts), so nothing can be
 * saved here that the page would refuse, and it is an act — the chat asks
 * before it runs unless the person said always.
 *
 * One document is read here and never written: which tools a chat may run
 * without asking (permission-prefs.ts). A model that could put itself on
 * that list would be answering its own permission question; that choice
 * stays on the Preferences page and the permission card.
 *
 * A change is announced on the turn's stream (emitPreferencesChanged), so
 * the page the person is looking at re-renders what the preference
 * decides — dark mode, the gutter, the default toolset — as the tool
 * returns (lib/preferences-events.ts), not on their next full load.
 */

import { isRecord } from '@renkei/guards';
import {
  patchPreferences,
  readAllPreferences,
  PREFERENCE_DOCUMENTS,
} from '@/lib/preferences/documents';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from '../local-tools';
import { getChatToolPermissionPrefs } from '../permission-prefs';
import { parseToolConfig, toolConfigJson, type ToolDefaultsKind } from '../tool-config';
import { getDefaultChatTools, setDefaultChatTools } from '../tool-prefs';
import { listChatConnectors } from '../tool-surface';
import { markdownLink } from './shared';

export const GET_PREFERENCES_TOOL = 'renkei_get_preferences';
export const SET_PREFERENCES_TOOL = 'renkei_set_preferences';

/** The name the default toolsets go by, here and in the change event. */
export const DEFAULT_TOOLS_DOCUMENT = 'defaultTools';

const DEFAULTS_KINDS: readonly ToolDefaultsKind[] = ['chat', 'code'];

async function readDefaultTools(subject: string) {
  const [chat, code] = await Promise.all(
    DEFAULTS_KINDS.map((kind) => getDefaultChatTools(subject, { fresh: true, kind }))
  );
  return {
    chat: chat ? toolConfigJson(chat).connectors : null,
    code: code ? toolConfigJson(code).connectors : null,
  };
}

async function getPreferences(input: Record<string, unknown>, context: LocalToolContext) {
  const [documents, defaultTools, permissions] = await Promise.all([
    readAllPreferences(context.subject),
    readDefaultTools(context.subject),
    getChatToolPermissionPrefs(context.subject, { fresh: true }),
  ]);
  // The notification grid is long; it rides along only when asked for.
  const { notifications, ...rest } = documents;
  const shown = {
    ...rest,
    ...(input.includeNotifications === true ? { notifications } : {}),
    [DEFAULT_TOOLS_DOCUMENT]: defaultTools,
    toolPermissions: permissions,
  };
  return textResult(
    `This person's preferences (null means "no choice saved": the organization's or the built-in default applies):\n` +
      `${JSON.stringify(shown, null, 2)}\n\n` +
      `${DEFAULT_TOOLS_DOCUMENT} lists connector keys a new chat ("chat") or a new code project ("code") starts with. ` +
      `toolPermissions is read-only here. ` +
      (input.includeNotifications === true
        ? ''
        : 'The notification settings were left out; pass includeNotifications to see them. ') +
      `The page: ${markdownLink(context, 'Preferences', '/preferences')}`
  );
}

type DefaultsChange = { kind: ToolDefaultsKind; connectors: string[] | null };

/** The `defaultTools` part of a change, checked against what this person can offer a chat. */
async function readDefaultsChange(
  raw: unknown,
  subject: string
): Promise<{ ok: true; changes: DefaultsChange[] } | { ok: false; error: string }> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: `${DEFAULT_TOOLS_DOCUMENT} must be an object with "chat" and/or "code".`,
    };
  }
  const unknown = Object.keys(raw).filter((key) => key !== 'chat' && key !== 'code');
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `${DEFAULT_TOOLS_DOCUMENT} has no "${unknown.join('", "')}"; it has "chat" and "code".`,
    };
  }
  const changes: DefaultsChange[] = [];
  for (const kind of DEFAULTS_KINDS) {
    const value = raw[kind];
    if (value === undefined) continue;
    if (value === null) {
      changes.push({ kind, connectors: null });
      continue;
    }
    const config = parseToolConfig({ connectors: value });
    if (!config) {
      return {
        ok: false,
        error: `${DEFAULT_TOOLS_DOCUMENT}.${kind} must be a list of connector keys, or null to clear it.`,
      };
    }
    changes.push({ kind, connectors: config.connectors });
  }
  if (changes.length === 0) {
    return { ok: false, error: `${DEFAULT_TOOLS_DOCUMENT} names neither "chat" nor "code".` };
  }
  const wanted = changes.flatMap((change) => change.connectors ?? []);
  if (wanted.length > 0) {
    const offered = new Set((await listChatConnectors(subject)).map((option) => option.key));
    const missing = [...new Set(wanted.filter((key) => !offered.has(key)))];
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Not a connector this person can turn on: ${missing.join(', ')}. Theirs are: ${[...offered].sort().join(', ') || 'none'}.`,
      };
    }
  }
  return { ok: true, changes };
}

async function setPreferences(input: Record<string, unknown>, context: LocalToolContext) {
  const { [DEFAULT_TOOLS_DOCUMENT]: defaultsRaw, ...documents } = input;
  if (defaultsRaw === undefined && Object.keys(documents).length === 0) {
    return errorResult(
      `Nothing to change. Name a document (${PREFERENCE_DOCUMENTS.join(', ')}, ${DEFAULT_TOOLS_DOCUMENT}) and the fields to set.`
    );
  }
  if ('toolPermissions' in documents) {
    return errorResult(
      'Which tools run without asking is not changed from a chat. The person sets it on the Preferences page, or with "Always allow" on a permission card.'
    );
  }
  // Everything is read and checked before anything is written.
  const defaults =
    defaultsRaw === undefined ? null : await readDefaultsChange(defaultsRaw, context.subject);
  if (defaults && !defaults.ok) return errorResult(`${defaults.error} Nothing was saved.`);

  const changed: string[] = [];
  if (Object.keys(documents).length > 0) {
    const outcome = await patchPreferences(context.subject, documents);
    if (!outcome.ok) {
      if (outcome.kind === 'invalid') return errorResult(`${outcome.error}. Nothing was saved.`);
      return errorResult(
        `The ${outcome.document} preferences could not be saved (${outcome.cause}). Tell the person it failed.`
      );
    }
    changed.push(...outcome.changed);
  }
  if (defaults) {
    for (const change of defaults.changes) {
      const written = await setDefaultChatTools(
        context.subject,
        change.connectors === null ? null : { connectors: change.connectors },
        change.kind
      );
      if (!written.ok) {
        // What the earlier documents saved still moved: say so on the stream.
        if (changed.length > 0) context.emitPreferencesChanged?.({ documents: changed });
        return errorResult(
          `The default tools for ${change.kind === 'code' ? 'code projects' : 'new chats'} could not be saved. Tell the person it failed${changed.length > 0 ? `; ${changed.join(', ')} was saved` : ''}.`
        );
      }
    }
    changed.push(DEFAULT_TOOLS_DOCUMENT);
  }
  context.emitPreferencesChanged?.({ documents: changed });
  const [after, defaultTools] = await Promise.all([
    readAllPreferences(context.subject),
    readDefaultTools(context.subject),
  ]);
  const saved: Record<string, unknown> = {};
  for (const name of changed) {
    saved[name] = name === DEFAULT_TOOLS_DOCUMENT ? defaultTools : Reflect.get(after, name);
  }
  return textResult(
    `Saved. The page the person has open follows the change at once; if something on it still looks as it did, tell them to refresh their browser. As now stored:\n${JSON.stringify(saved, null, 2)}`
  );
}

export function preferenceTools(): LocalTool[] {
  return [
    {
      readOnly: true,
      def: {
        name: GET_PREFERENCES_TOOL,
        description:
          "This person's own Renkei preferences as now saved: appearance (theme mode, line numbers in code blocks), voice, image model, tours, chat archiving, the default tools a new chat and a new code project start with, and which tools may run without asking. Call it before changing a preference, to see the fields and their current values. Notification settings are long and included only with includeNotifications.",
        inputSchema: {
          type: 'object',
          properties: {
            includeNotifications: {
              type: 'boolean',
              description: 'Also return the notification settings.',
            },
          },
        },
      },
      execute: getPreferences,
    },
    {
      def: {
        name: SET_PREFERENCES_TOOL,
        description:
          'Change this person\'s own Renkei preferences, when they ask for it ("switch to dark mode", "show line numbers", "start my chats with Jira on"). Send only the fields to change; everything else stays as saved. The page they have open re-renders at once. Fields not listed here (voice\'s others, notifications) are as renkei_get_preferences returns them. Which tools run without asking cannot be changed here.',
        inputSchema: {
          type: 'object',
          properties: {
            theme: {
              type: 'object',
              description: 'Appearance.',
              properties: {
                mode: {
                  type: 'string',
                  enum: ['auto', 'light', 'dark'],
                  description: 'auto follows the system.',
                },
                codeLineNumbers: {
                  type: 'boolean',
                  description: 'A line-number gutter on fenced code blocks.',
                },
              },
            },
            voice: {
              type: 'object',
              description:
                'Voice: voice (id or null), rate (0.5–2), autoPlay, locale (or null), detectLanguage, pushToTalk, accent, userAccent.',
            },
            image: {
              type: 'object',
              description: 'The image generation model.',
              properties: {
                modelId: {
                  type: ['string', 'null'],
                  description: 'null is the organization default.',
                },
              },
            },
            coachMarks: {
              type: 'object',
              description: 'The guided tours.',
              properties: {
                autoStart: { type: 'boolean', description: 'Whether tours start unasked.' },
              },
            },
            chatArchive: {
              type: 'object',
              description: 'Archiving idle chats.',
              properties: {
                afterDays: {
                  type: ['integer', 'null'],
                  description: 'Archive a chat untouched this many days; null is the default.',
                },
              },
            },
            notifications: {
              type: 'object',
              description:
                'Notification settings, in the shape renkei_get_preferences returns with includeNotifications. Read them first.',
            },
            [DEFAULT_TOOLS_DOCUMENT]: {
              type: 'object',
              description:
                'The connectors a new chat ("chat") or a new code project ("code") starts with: a list of connector keys, or null to go back to the built-in default.',
              properties: {
                chat: { type: ['array', 'null'], items: { type: 'string' } },
                code: { type: ['array', 'null'], items: { type: 'string' } },
              },
            },
          },
        },
      },
      execute: setPreferences,
    },
  ];
}
