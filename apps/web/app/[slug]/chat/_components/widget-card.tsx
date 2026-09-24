'use client';

/**
 * The host side of an MCP Apps widget card (SEP-1865) — Renkei's own
 * equivalent of what an external host like Claude Desktop already does
 * with the same `ui://` resources (lib/mcp-widgets/, lib/mcp-tools/widgets.ts).
 * A preview tool's result carries a bound resourceUri (turn-runner.ts,
 * off tools/list's `_meta.ui.resourceUri`); this mounts that resource in a
 * sandboxed iframe and speaks the host half of the protocol the card's own
 * bridge.ts speaks: answer its `ui/initialize` handshake, hand it the
 * call's input and result, proxy its `tools/call` (the confirm button) to
 * a real MCP call scoped to app-only tools, open links, hand
 * `ui/update-model-context` to the server — which records it as a note
 * and opens the model's turn on it — and tell the thread (`onModelContext`)
 * so it shows the note and streams that reply, and follow its
 * `size-changed` reports.
 *
 * Every message is checked against `event.source` — the iframe has no
 * `allow-same-origin` (sandbox="allow-scripts" alone forces an opaque
 * origin whatever its `src`), so nothing but that specific frame can ever
 * satisfy the check, whatever origin claims to send a message.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { chatClient } from '@/lib/chat/client';
import type { ChatBlock } from '@/lib/chat/views';
import type { WidgetModelContextOutcome } from '@/lib/chat/widget-tools';

type ToolResultBlock = Extract<ChatBlock, { type: 'tool_result' }>;

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/** A JSON object or nothing — narrowed without an assertion. */
function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return plainObject(value)?.jsonrpc === '2.0';
}

function textContentOf(content: string): { type: string; text: string }[] {
  return content ? [{ type: 'text', text: content }] : [];
}

/** The text of an `ui/update-model-context` call's `content` param. */
function joinedText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (typeof block !== 'object' || block === null) return [];
      const entry: { type?: unknown; text?: unknown } = block;
      return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
    })
    .join('\n');
}

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 96;

export default function WidgetCard({
  tenantId,
  chatId,
  resourceUri,
  toolInput,
  result,
  onModelContext = null,
}: {
  tenantId: string;
  chatId: string;
  resourceUri: string;
  toolInput: unknown;
  /** The tool_result block the call finished with — only rendered once one exists. */
  result: ToolResultBlock;
  /**
   * The card's decision landed: the note row to show and, when one
   * started, the turn to stream — the thread's to act on (chat-thread.tsx).
   */
  onModelContext?: ((outcome: WidgetModelContextOutcome) => void) | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  // The iframe gets no `src` on the FIRST render, only from here on. The
  // message this page renders (with its tool_result blocks) is server
  // rendered, so an iframe with its real `src` from the start begins
  // loading and running the widget bundle the instant the browser parses
  // that HTML — well before React hydrates and this component's effects
  // ever run. The widget sends `ui/initialize` the moment it loads, and a
  // `postMessage` a listener was not yet attached for is gone for good;
  // that handshake was consistently lost this way. Starting with no `src`
  // means the only navigation happens once `ready` flips true below,
  // which the effect does only after the listener is already attached —
  // so the handshake the widget sends on THAT load always has a listener
  // waiting for it.
  const [ready, setReady] = useState(false);

  const post = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message: unknown = event.data;
      if (!isRpcMessage(message)) return;
      const { id, method, params } = message;

      switch (method) {
        case 'ui/initialize': {
          if (id === undefined) return;
          const theme =
            document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
          post({ id, result: { hostContext: { theme } } });
          return;
        }
        case 'ui/notifications/initialized':
          post({ method: 'ui/notifications/tool-input', params: { arguments: toolInput ?? {} } });
          post({
            method: 'ui/notifications/tool-result',
            params: {
              isError: result.isError === true,
              content: textContentOf(result.content),
              ...('structuredContent' in result
                ? { structuredContent: result.structuredContent }
                : {}),
            },
          });
          return;
        case 'tools/call': {
          if (id === undefined) return;
          const name = typeof params?.name === 'string' ? params.name : '';
          const args = plainObject(params?.arguments) ?? {};
          void chatClient
            .confirmWidgetTool(tenantId, chatId, name, args)
            .then(({ data, error }) => {
              if (error || !data) {
                post({
                  id,
                  error: { code: -32000, message: error ?? 'The tool could not be reached.' },
                });
                return;
              }
              post({ id, result: data.result });
            });
          return;
        }
        case 'ui/open-link': {
          if (id === undefined) return;
          const url = typeof params?.url === 'string' ? params.url : '';
          post({ id, result: {} });
          if (url) window.open(url, '_blank', 'noopener');
          return;
        }
        case 'ui/update-model-context': {
          if (id === undefined) return;
          post({ id, result: {} });
          const text = joinedText(params?.content);
          // Best-effort, same as the card's own bridge treats it: a turn
          // running right now (409) means this update is simply lost.
          if (!text) return;
          void chatClient.appendWidgetModelContext(tenantId, chatId, text).then(({ data }) => {
            if (data?.message) onModelContext?.(data);
          });
          return;
        }
        case 'ui/notifications/size-changed': {
          const raw = params?.height;
          if (typeof raw === 'number' && Number.isFinite(raw)) {
            setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(raw))));
          }
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener('message', onMessage);
    setReady(true);
    return () => window.removeEventListener('message', onMessage);
  }, [post, toolInput, result, tenantId, chatId, onModelContext]);

  return (
    <div className="my-2 max-w-md overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <iframe
        ref={iframeRef}
        src={ready ? chatClient.widgetResourceUrl(tenantId, resourceUri) : undefined}
        sandbox="allow-scripts"
        style={{
          width: '100%',
          height,
          border: 'none',
          display: 'block',
          transition: 'height 120ms ease',
        }}
        title="Preview card"
      />
    </div>
  );
}
