/**
 * MCP Apps wiring: the ui:// widget resources and the _meta conventions that
 * bind tools to them (SEP-1865, extension revision 2026-01-26).
 *
 * A preview tool declares `_meta.ui.resourceUri` pointing at one of the
 * templates below; a host that supports MCP Apps fetches the template,
 * renders it in a sandboxed iframe, and delivers the tool's result to it.
 * The card then calls the matching *_confirm tool through the host — those
 * are declared app-only (`_meta.ui.visibility: ['app']`) so the model never
 * sees them, with a description guard as belt-and-braces for hosts that
 * predate the visibility field.
 *
 * Resources register on the RAW server in the MCP route, not through
 * registerRenkeiTools: the gate proxies only intercept registerTool, and the
 * tool catalog's collecting server implements nothing else — routing
 * resources through registration would crash enumeration for no gain, since
 * a template with no tool bound to it is inert.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { EMAIL_COMPOSE_HTML, EMAIL_COMPOSE_HASH } from '@/lib/mcp-widgets/generated/email-compose';
import { CHAT_MESSAGE_HTML, CHAT_MESSAGE_HASH } from '@/lib/mcp-widgets/generated/chat-message';
import {
  MEETING_PREVIEW_HTML,
  MEETING_PREVIEW_HASH,
} from '@/lib/mcp-widgets/generated/meeting-preview';
import { ISSUE_PREVIEW_HTML, ISSUE_PREVIEW_HASH } from '@/lib/mcp-widgets/generated/issue-preview';
import { RESULTS_LIST_HTML, RESULTS_LIST_HASH } from '@/lib/mcp-widgets/generated/results-list';

// The content hash in each URI is the cache-buster: hosts cache templates by
// URI, and a stale template silently misrenders a newer data contract (a
// grouped payload on a flat-rows template drew "No results." over 100 real
// rows). A changed bundle is a changed URI, so a host can never pair an old
// template with new data.
export const EMAIL_COMPOSE_URI = `ui://widget/email-compose.${EMAIL_COMPOSE_HASH}.html`;
export const CHAT_MESSAGE_URI = `ui://widget/chat-message.${CHAT_MESSAGE_HASH}.html`;
export const MEETING_PREVIEW_URI = `ui://widget/meeting-preview.${MEETING_PREVIEW_HASH}.html`;
export const ISSUE_PREVIEW_URI = `ui://widget/issue-preview.${ISSUE_PREVIEW_HASH}.html`;
export const RESULTS_LIST_URI = `ui://widget/results-list.${RESULTS_LIST_HASH}.html`;

const WIDGET_MIME = 'text/html;profile=mcp-app';

/**
 * `_meta` for a preview tool: binds its result to a widget template. Spread
 * into registerTool config as `_meta: previewToolMeta(EMAIL_COMPOSE_URI)`.
 */
export function previewToolMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri } };
}

/**
 * `_meta` for a confirm tool: invocable by the widget, hidden from the model.
 */
export const APP_ONLY_META: Record<string, unknown> = { ui: { visibility: ['app'] } };

/**
 * The description guard for confirm tools, for hosts that ignore
 * `visibility`. Same job as Asana's "DEPRECATED; DO NOT USE" convention,
 * phrased as what the tool actually is.
 */
export function confirmGuard(previewTool: string): string {
  return (
    ` Only the preview card's buttons invoke this tool; do NOT call it directly — ` +
    `call ${previewTool} instead and let the user decide from the card.`
  );
}

const TEMPLATES: Array<{
  name: string;
  uri: string;
  description: string;
  html: string;
  /** Extra CSP resource origins (images); default is none — fully inline. */
  resourceDomains?: string[];
}> = [
  {
    name: 'email_compose',
    uri: EMAIL_COMPOSE_URI,
    description: 'Preview of an email draft awaiting the user’s send or discard.',
    html: EMAIL_COMPOSE_HTML,
  },
  {
    name: 'chat_message',
    uri: CHAT_MESSAGE_URI,
    description: 'Preview of a chat message awaiting the user’s send or cancel.',
    html: CHAT_MESSAGE_HTML,
  },
  {
    name: 'meeting_preview',
    uri: MEETING_PREVIEW_URI,
    description: 'Preview of a meeting awaiting the user’s create or cancel.',
    html: MEETING_PREVIEW_HTML,
  },
  {
    name: 'issue_preview',
    uri: ISSUE_PREVIEW_URI,
    description: 'Preview of a work item (Jira issue or JSM request) awaiting confirmation.',
    html: ISSUE_PREVIEW_HTML,
  },
  {
    name: 'results_list',
    uri: RESULTS_LIST_URI,
    description: 'Read-only results card: issues, requests, or comment threads with links.',
    html: RESULTS_LIST_HTML,
    // Assignee/reporter avatars. Atlassian serves them from the site domain,
    // its avatar service, or Gravatar; the card renders initials first and
    // layers the image on top, so a host this list misses degrades to
    // initials rather than a broken image.
    resourceDomains: [
      'https://*.atlassian.net',
      'https://*.prod.public.atl-paas.net',
      'https://secure.gravatar.com',
      'https://*.gravatar.com',
    ],
  },
];

export function registerWidgetResources(server: McpServer): void {
  for (const template of TEMPLATES) {
    server.registerResource(
      template.name,
      template.uri,
      {
        description: template.description,
        mimeType: WIDGET_MIME,
        _meta: {
          ui: {
            // The cards are fully self-contained — no external fetches, and
            // no external assets beyond what a template names explicitly
            // (today: avatar images on the results card). Declaring the
            // empty lists gets the host's strictest CSP rather than its
            // defaults.
            csp: { connectDomains: [], resourceDomains: template.resourceDomains ?? [] },
            prefersBorder: true,
          },
        },
      },
      () => ({
        contents: [{ uri: template.uri, mimeType: WIDGET_MIME, text: template.html }],
      })
    );
  }
}
