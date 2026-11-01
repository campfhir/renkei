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
 *
 * What each message means — the replies, the calls, the decision a
 * receipt maps to, the height clamp — is widget-card.model.ts, tested in
 * node (widget-card.model.test.ts); this component carries it out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { chatClient } from '@/lib/chat/client';
import type { WidgetModelContextOutcome } from '@/lib/chat/widget-tools';
import {
  DEFAULT_HEIGHT,
  hostEffects,
  resolvedKeyOf,
  toolCallReply,
  toolResultNotification,
  type HostEffect,
  type Outgoing,
  type ToolResultBlock,
} from './widget-card.model';

export default function WidgetCard({
  chatId,
  resourceUri,
  toolInput,
  result,
  onModelContext = null,
}: {
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
  // Whether the card has finished its handshake — the point from which a
  // later change to the result (below) can be pushed to it, rather than
  // waiting to be handed over at `ui/notifications/initialized`.
  const initializedRef = useRef(false);

  const post = useCallback((message: Outgoing) => {
    iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
  }, []);

  // A decision that arrives AFTER the card rendered — the model marking
  // it decided on the person's word (chat_widget_resolve, carried by the
  // turn's `widget_decided` event) — is handed to the card as a second
  // tool-result notification: every widget bundle re-renders from scratch
  // on each one (mcp-widgets/src/*.ts's `bridge.toolResult`), and reads
  // `resolved` off the payload the way it does on first load, so the live
  // buttons give way to the receipt without a reload. Keyed on the
  // receipt's content, not the block's identity, so a re-render that
  // leaves the decision as it was posts nothing.
  const resolvedKey = resolvedKeyOf(result);
  const latestResult = useRef(result);
  latestResult.current = result;
  useEffect(() => {
    if (!resolvedKey || !initializedRef.current) return;
    post(toolResultNotification(latestResult.current));
  }, [resolvedKey, post]);

  useEffect(() => {
    // What the card's message means is widget-card.model.ts's to decide;
    // carrying it out (the frame, the server, a new tab) is this one's.
    const run = (effect: HostEffect) => {
      switch (effect.type) {
        case 'post':
          post(effect.message);
          return;
        case 'initialized':
          initializedRef.current = true;
          return;
        case 'call-tool':
          void chatClient
            .confirmWidgetTool(chatId, effect.name, effect.args, effect.stateKey)
            .then((answer) => post(toolCallReply(effect.id, answer)));
          return;
        case 'report-decision':
          void chatClient.reportWidgetDecision(
            chatId,
            effect.stateKey,
            effect.decision,
            effect.state
          );
          return;
        case 'open-link':
          window.open(effect.url, '_blank', 'noopener');
          return;
        case 'model-context':
          // Best-effort, same as the card's own bridge treats it: a note
          // the server could not write at all is simply lost.
          void chatClient
            .appendWidgetModelContext(chatId, effect.text, effect.stateKey)
            .then(({ data }) => {
              if (data?.message) onModelContext?.(data);
            });
          return;
        case 'resize':
          setHeight(effect.height);
          return;
      }
    };
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const theme =
        document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      hostEffects(event.data, { theme, toolInput, result }).forEach(run);
    };
    window.addEventListener('message', onMessage);
    setReady(true);
    return () => window.removeEventListener('message', onMessage);
  }, [post, toolInput, result, chatId, onModelContext]);

  return (
    <div className="my-2 max-w-md overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <iframe
        ref={iframeRef}
        src={ready ? chatClient.widgetResourceUrl(resourceUri) : undefined}
        sandbox="allow-scripts"
        className="block w-full border-none motion-safe:transition-[height] motion-safe:duration-[120ms] motion-safe:ease-[ease]"
        style={{ height }}
        title="Preview card"
      />
    </div>
  );
}
