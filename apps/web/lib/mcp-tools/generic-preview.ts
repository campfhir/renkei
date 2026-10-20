/**
 * A preview card for every act tool that does not have one of its own.
 *
 * Chat does not offer the direct act tools (tool-surface.ts): an act reaches
 * a person's systems only after they press a card's button, so a model that
 * is told "send it" cannot send it past the card by calling the plain tool
 * instead of its `*_preview`. That only works if EVERY act tool has a
 * preview. The ones written by hand (Outlook mail, Jira issues, Webex,
 * Zoom, the pull-request and directory writes) have a card shaped to the
 * act; this fills in the rest — a Confluence page, a SharePoint document, a
 * Jira comment — with a generic one, so adding an act tool never reopens
 * the gap.
 *
 * ## What it registers
 *
 * For an eligible act tool `x`, once every module has registered (`flush`):
 *
 *  - `x_preview` — same input schema as `x`, writes nothing; it renders the
 *    arguments as a card (the directory-action template, which is already a
 *    titled list of fields with a confirm and a cancel) whose confirm button
 *    calls `x_confirm`. Marked `renkei/preview-of: x` so the agent builder
 *    can leave it out: an agent has no card to press, and keeps `x`.
 *  - `x_confirm` — app-only (widgets.ts's APP_ONLY_META), registered for the
 *    widget token alone (capability-gate.ts's `withAppOnlyGate`), running
 *    `x`'s own handler, so the confirm path IS the direct path. A card
 *    therefore does exactly what the tool would have done.
 *
 * `x` itself stays registered. Agent runs (which have the act-approval
 * batch in front of their acts) and external MCP clients call it as ever;
 * it is chat that does not offer it.
 *
 * The twins are registered on the server this wraps, bypassing the gates
 * layered outside it. That is deliberate and safe: `x` reached this proxy
 * only because those gates admitted it, and the twins carry the same kind
 * (act), connector and scopes, so the decision they would make is the one
 * already made. A route-level allow-list or app-only gate sits outside this
 * and still applies to the twins.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { ACT_OUTCOMES, connectorKeyForTool, type ActCategory } from '@renkei/tool-outcomes';
import { isAppOnlyTool } from './capability-gate';
import {
  APP_ONLY_META,
  DIRECTORY_ACTION_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from './widgets';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

/** `_meta` key on a generated preview naming the direct tool it stands in for. */
export const PREVIEW_OF_META_KEY = 'renkei/preview-of';

/**
 * Connectors whose acts stay platform-internal — the person's own scratch
 * space, feed cards, knowledge notes, agents, memory and logs. Nothing here
 * reaches another system or another person, and a chat already asks before
 * any of them acts, so a card in front of every sandbox command would only
 * make the sandbox unusable. Everything else — every external system — gets
 * a preview.
 */
export const PREVIEW_EXEMPT_CONNECTORS: readonly string[] = [
  'agents',
  'batch-jobs',
  'cards',
  'knowledge',
  'logs',
  'sandbox',
  'user-memory',
];

/**
 * Direct tools whose hand-written preview is not named `<tool>_preview`:
 * the Outlook reply family previews as `outlook_reply_preview`, not
 * `outlook_reply_message_preview`.
 */
const PREVIEW_TWIN_OVERRIDES: Readonly<Record<string, string>> = {
  outlook_reply_message: 'outlook_reply_preview',
  outlook_reply_all_message: 'outlook_reply_all_preview',
  outlook_forward_message: 'outlook_forward_preview',
};

/** `*_request_*_upload` hands back a URL and changes nothing until bytes follow. */
const UPLOAD_PLUMBING = /_request_\w*upload$/;
const TWIN_SUFFIX = /_(preview|confirm)$/;

/**
 * The preview that stands in for a direct tool, among the tools `names`
 * registers — hand-written or generated — or null when it has none.
 */
export function previewTwinOf(tool: string, names: ReadonlySet<string>): string | null {
  const override = PREVIEW_TWIN_OVERRIDES[tool];
  if (override !== undefined) return names.has(override) ? override : null;
  const twin = `${tool}_preview`;
  return names.has(twin) ? twin : null;
}

/** Whether an act tool is one a card should stand in front of. */
export function needsPreview(name: string, config: RegisterToolArgs[1]): boolean {
  if (config.annotations?.readOnlyHint === true) return false;
  if (isAppOnlyTool(config)) return false;
  if (TWIN_SUFFIX.test(name) || UPLOAD_PLUMBING.test(name)) return false;
  const connector = connectorKeyForTool(name);
  return connector === null || !PREVIEW_EXEMPT_CONNECTORS.includes(connector);
}

const MAX_FIELDS = 40;
const MAX_VALUE = 600;

const humanize = (key: string): string => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function displayValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const shown = text ?? String(value);
  return shown.length > MAX_VALUE
    ? `${shown.slice(0, MAX_VALUE)}… (${shown.length} characters)`
    : shown;
}

/** One card row per argument the model supplied, in the order it supplied them. */
export function previewFields(args: Record<string, unknown>): { label: string; value: string }[] {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, MAX_FIELDS)
    .map(([key, value]) => ({ label: humanize(key), value: displayValue(value) }));
}

const VERB: Record<ActCategory, string> = {
  created: 'Create',
  sent: 'Send',
  updated: 'Update',
  deleted: 'Delete',
  scheduled: 'Schedule',
  other: 'Confirm',
};

/** "Outlook · Act — Send an email" → what it does, and the system it does it in. */
function titleParts(name: string, title: unknown): { what: string; system: string } {
  const text = typeof title === 'string' ? title : '';
  const [head, ...rest] = text.split(' — ');
  const what = rest.join(' — ') || ACT_OUTCOMES[name]?.short || humanize(name);
  const system = head && rest.length > 0 ? (head.split(' · ')[0] ?? '') : '';
  return { what, system };
}

export function buildPreviewCard(
  name: string,
  title: unknown,
  args: Record<string, unknown>
): Record<string, unknown> {
  const category = ACT_OUTCOMES[name]?.category ?? 'other';
  const { what, system } = titleParts(name, title);
  return {
    kind: 'directory_action',
    previewId: newPreviewId(),
    action: VERB[category],
    tone: category === 'deleted' || category === 'sent' ? 'caution' : 'neutral',
    title: what,
    ...(system ? { subtitle: system } : {}),
    fields: previewFields(args),
    confirmTool: `${name}_confirm`,
    confirmLabel: VERB[category],
    confirmArgs: args,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface GenericPreviewServer {
  server: McpServer;
  /** Register the generated twins; call once, after every module has registered. */
  flush(): void;
}

/**
 * Wrap a server so each act tool registered through it is remembered, and
 * `flush()` then registers the preview/confirm pair for the ones that have
 * no preview of their own. Registration order does not matter: the
 * decision waits until every name is known.
 */
export function withGenericPreview(target: McpServer): GenericPreviewServer {
  const registered = new Set<string>();
  const candidates: { name: string; config: RegisterToolArgs[1]; handler: RegisterToolArgs[2] }[] =
    [];

  const server = new Proxy(target, {
    get(inner, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          registered.add(name);
          if (typeof handler === 'function' && needsPreview(name, config)) {
            candidates.push({ name, config, handler });
          }
          return inner.registerTool(...args);
        };
      }
      const value: unknown = Reflect.get(inner, property, receiver);
      return typeof value === 'function' ? value.bind(inner) : value;
    },
  });

  const flush = () => {
    for (const { name, config, handler } of candidates) {
      if (previewTwinOf(name, registered) !== null) continue;
      const previewName = `${name}_preview`;
      const confirmName = `${name}_confirm`;
      if (registered.has(previewName) || registered.has(confirmName)) continue;
      registered.add(previewName);
      registered.add(confirmName);
      const hasInput = config.inputSchema !== undefined;
      const what = titleParts(name, config.title).what;

      // The SDK types a tool callback as a union over "has an input schema or
      // not", so a callback built here cannot be inferred across it; both
      // return the content-result member of that union. Same idiom as
      // withKindStamp.
      const preview = async (...handlerArgs: unknown[]) => {
        const args = hasInput && isRecord(handlerArgs[0]) ? handlerArgs[0] : {};
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${what} is awaiting the user's decision on the preview card. Do not run it ` +
                `another way and do not repeat its contents in your reply; the user confirms ` +
                `or cancels from the card. If no card appeared in this client, ask the user ` +
                `how to proceed.`,
            },
          ],
          structuredContent: buildPreviewCard(name, config.title, args),
        };
      };
      const previewConfig: RegisterToolArgs[1] = {
        title: `${typeof config.title === 'string' ? config.title : name} (preview)`,
        description:
          `Show the user a preview card of this action to confirm or cancel; nothing happens ` +
          `until they confirm on the card, and the card does the acting. Same arguments as ` +
          `${name}. — ${config.description ?? what}`,
        annotations: { readOnlyHint: false },
        _meta: { ...previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI), [PREVIEW_OF_META_KEY]: name },
        inputSchema: config.inputSchema,
      };
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      target.registerTool(previewName, previewConfig, preview as RegisterToolArgs[2]);
      target.registerTool(
        confirmName,
        {
          ...config,
          title: `${typeof config.title === 'string' ? config.title : name} (card only)`,
          description: `Run ${name} for an action the user approved on a preview card.${confirmGuard(previewName)}`,
          annotations: { ...config.annotations, readOnlyHint: false },
          _meta: APP_ONLY_META,
        },
        handler
      );
    }
  };

  return { server, flush };
}
