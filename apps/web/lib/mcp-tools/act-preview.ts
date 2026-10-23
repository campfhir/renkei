/**
 * A bespoke preview card for every act tool.
 *
 * Chat does not offer the plain act tools (tool-surface.ts): an act reaches
 * a person's systems only after they press a card's button, so a model that
 * is told "send it" cannot send it past the card by calling the plain tool
 * instead of its `*_preview`. That only works if EVERY act tool has a
 * preview. Some are written by hand next to their tools (Outlook mail, Jira
 * issues, Webex, Zoom meetings, the pull-request merge and open, directory
 * writes); every other act has a builder in `previews/` that draws it the
 * way the thing looks — a comment, a status moving, a worklog, an issue
 * link, an access change, a page, a file operation, a commit — on the
 * act-preview card (mcp-widgets/src/act-card.ts). There is no fallback that
 * prints the arguments: a tool without a builder gets no preview, and a
 * test fails until it has one.
 *
 * ## What it registers
 *
 * For an eligible act tool `x` that has a builder, once every module has
 * registered (`flush`):
 *
 *  - `x_preview` — same input schema as `x`, writes nothing; it answers with
 *    the builder's card, whose confirm button calls `x_confirm`. Marked
 *    `renkei/preview-of: x` so the agent builder can leave it out: an agent
 *    has no card to press, and keeps `x`.
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
import { connectorKeyForTool } from '@renkei/tool-outcomes';
import type { ActCard } from '@/lib/mcp-widgets/src/act-card';
import { isAppOnlyTool } from './capability-gate';
import { PREVIEW_BUILDERS } from './previews';
import type { PreviewBuilder } from './previews/card';
import {
  APP_ONLY_META,
  ACT_PREVIEW_URI,
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
  // Its acts write change requests and templates in Renkei, applied from
  // Renkei's own review page; none changes Jira (jira-admin/propose-*.ts).
  'jira-admin',
  'knowledge',
  'logs',
  // Same as jira-admin: its proposals write change requests in Renkei,
  // validated by Salesforce and applied only from Renkei's review page.
  'salesforce-admin',
  'sandbox',
  'user-memory',
];

/** Single tools that only write to Renkei: a suggestion on the feed, never to the provider. */
export const PREVIEW_EXEMPT_TOOLS: readonly string[] = [
  'webex_capture_message',
  // Stages a file in the person's own scratch space; Salesforce is only read.
  'salesforce_download_file',
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
  if (PREVIEW_EXEMPT_TOOLS.includes(name)) return false;
  const connector = connectorKeyForTool(name);
  return connector === null || !PREVIEW_EXEMPT_CONNECTORS.includes(connector);
}

/**
 * The card a builder draws for these arguments, ready to hand to the card
 * bundle. The builder's `confirmWith` (for a tool with its own "preview,
 * then confirm" step) is folded into the arguments the confirm button sends.
 */
export function buildPreviewCard(
  builder: PreviewBuilder,
  name: string,
  args: Record<string, unknown>
): ActCard {
  const { confirmWith, ...spec } = builder(args);
  return {
    ...spec,
    kind: 'act',
    previewId: newPreviewId(),
    confirmTool: `${name}_confirm`,
    confirmArgs: { ...args, ...confirmWith },
  };
}

/** "Outlook · Act — Send an email" → "Send an email". */
function whatOf(name: string, title: unknown): string {
  const text = typeof title === 'string' ? title : '';
  const tail = text.split(' — ').slice(1).join(' — ');
  return tail || name;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ActPreviewServer {
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
export function withActPreviews(target: McpServer): ActPreviewServer {
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
      const builder = PREVIEW_BUILDERS[name];
      // No card, no preview: the tool stays plain until one is written (the
      // catalog test says which), rather than getting a card that prints
      // its arguments.
      if (builder === undefined) continue;
      const previewName = `${name}_preview`;
      const confirmName = `${name}_confirm`;
      if (registered.has(previewName) || registered.has(confirmName)) continue;
      registered.add(previewName);
      registered.add(confirmName);
      const hasInput = config.inputSchema !== undefined;
      const what = whatOf(name, config.title);

      // The SDK types a tool callback as a union over "has an input schema or
      // not", so a callback built here cannot be inferred across it; both
      // return the content-result member of that union. Same idiom as
      // withKindStamp.
      const preview = async (...handlerArgs: unknown[]) => {
        const args = hasInput && isRecord(handlerArgs[0]) ? handlerArgs[0] : {};
        let card: ActCard;
        try {
          card = buildPreviewCard(builder, name, args);
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `The preview could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
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
          structuredContent: card,
        };
      };
      const previewConfig: RegisterToolArgs[1] = {
        title: `${typeof config.title === 'string' ? config.title : name} (preview)`,
        description:
          `Show the user a preview card of this action to confirm or cancel; nothing happens ` +
          `until they confirm on the card, and the card does the acting. Same arguments as ` +
          `${name}. — ${config.description ?? what}`,
        annotations: { readOnlyHint: false },
        _meta: { ...previewToolMeta(ACT_PREVIEW_URI), [PREVIEW_OF_META_KEY]: name },
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
