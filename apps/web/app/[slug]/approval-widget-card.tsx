'use client';

/**
 * The real MCP Apps widget, hosted for a `needsApproval` card instead of a
 * chat turn — the richer UI chat's preview cards already have (project/type
 * header, editable summary/description, its own field rows) reused for an
 * agent's approval feed, per widget-card.tsx's own protocol but adapted:
 *
 * - The HTML comes from the SAME route chat's cards use
 *   (`/api/tenant/{tenantId}/chat/widgets`) — that route only ever checked
 *   for a signed-in tenant session, nothing chat-specific, so there is
 *   nothing to duplicate.
 * - `structuredContent` is built server-side, at render time, from the
 *   gate's own snapshotted `{tool, args}` (jiraIssueApprovalPreview) — no
 *   live tool call, so nothing runs before a person decides, same
 *   invariant the plain-list card kept.
 * - Both Confirm and Cancel call `tools/call` (jiraIssueApprovalPreview
 *   gives the card a `cancelTool`, which is what makes Cancel round-trip
 *   instead of finishing locally — see issue-preview.ts). Neither becomes a
 *   live MCP tool call here: this host POSTS a decision (with the button's
 *   args as an override) to the actionable-item's own decision route —
 *   approve for Confirm, decline for Cancel — and the real tool call, on
 *   approval, happens later inside the worker. Which decision a given
 *   `tools/call` means is read off `confirmOutcome`/`cancelOutcome` in
 *   structuredContent, not off the tool name itself — this card is the
 *   only place that needed to change to make Cancel BE the decline,
 *   instead of a second "no" control duplicating it outside the widget.
 * - `ui/update-model-context` has no chat turn to open here — acknowledged
 *   and otherwise ignored.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRefresh } from '@/lib/use-refresh';

/** Which decision a `tools/call` means, from the preview's own outcome
 * metadata — not from the tool name, which is free to be anything (or, for
 * Confirm, the real gated tool's own name). Defaults to approve: a card
 * that never set `cancelTool` never reaches here for anything but Confirm. */
function decisionOf(
  toolName: string,
  structuredContent: Record<string, unknown>
): 'approve' | 'decline' {
  const outcome =
    toolName === structuredContent.cancelTool
      ? structuredContent.cancelOutcome
      : structuredContent.confirmOutcome;
  return outcome === 'declined' ? 'decline' : 'approve';
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return plainObject(value)?.jsonrpc === '2.0';
}

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 220;

export default function ApprovalWidgetCard({
  tenantId,
  itemId,
  resourceUri,
  structuredContent,
}: {
  tenantId: string;
  itemId: string;
  resourceUri: string;
  structuredContent: Record<string, unknown>;
}): React.ReactNode {
  const { refresh } = useRefresh();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  // Same reason as widget-card.tsx: no `src` until a message listener is
  // attached, or the widget's own `ui/initialize` postMessage — sent the
  // instant its bundle loads — fires before anything here is listening.
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
          // Replaying a call that never actually ran — the "tool result" is
          // the structuredContent this render built, not a live response.
          post({ method: 'ui/notifications/tool-input', params: { arguments: {} } });
          post({
            method: 'ui/notifications/tool-result',
            params: { isError: false, content: [], structuredContent },
          });
          return;
        case 'tools/call': {
          if (id === undefined) return;
          const name = typeof params?.name === 'string' ? params.name : '';
          const decision = decisionOf(name, structuredContent);
          const args = plainObject(params?.arguments) ?? {};
          void fetch(`/api/tenant/${tenantId}/actionable-items/${itemId}/approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, args }),
          })
            .then(async (response) => {
              const body: unknown = await response.json().catch(() => null);
              const record = plainObject(body) ?? {};
              if (response.ok || response.status === 502) {
                post({
                  id,
                  result: {
                    isError: false,
                    content: [
                      {
                        type: 'text',
                        text:
                          typeof record.warning === 'string'
                            ? record.warning
                            : decision === 'approve'
                              ? 'Approved — the run will continue.'
                              : 'Declined.',
                      },
                    ],
                  },
                });
                refresh();
                return;
              }
              post({
                id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text:
                        typeof record.error === 'string'
                          ? record.error
                          : `Request failed (${response.status})`,
                    },
                  ],
                },
              });
            })
            .catch((error: unknown) => {
              post({
                id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: `The request could not be sent: ${error instanceof Error ? error.message : String(error)}`,
                    },
                  ],
                },
              });
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
          // No chat turn to open here — acknowledge and drop it, same as
          // the widget's own bridge treats any best-effort failure.
          if (id !== undefined) post({ id, result: {} });
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
  }, [post, tenantId, itemId, structuredContent, refresh]);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <iframe
        ref={iframeRef}
        src={
          ready
            ? `/api/tenant/${tenantId}/chat/widgets?${new URLSearchParams({ uri: resourceUri }).toString()}`
            : undefined
        }
        sandbox="allow-scripts"
        style={{
          width: '100%',
          height,
          border: 'none',
          display: 'block',
          transition: 'height 120ms ease',
        }}
        title="Approval preview"
      />
    </div>
  );
}
