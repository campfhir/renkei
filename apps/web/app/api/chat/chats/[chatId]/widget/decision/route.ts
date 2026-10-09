/**
 * A widget card's decision, once it finishes — Confirm or Cancel, whichever
 * the user picked (bridge.ts's `reportDecision`, sent from every card's
 * `finishDone`). Recorded in `chat_widget_decisions` so the same card,
 * opened on another device or after a reload, reads back this receipt
 * (chat-view.ts's `withResolvedWidgets`) instead of replaying live
 * Confirm/Cancel buttons for something already decided.
 *
 * Owner only, same as the card's other two callbacks (tool-call,
 * model-context) — a shared chat's viewer watches, the owner acts.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { recordWidgetDecision } from '@/lib/chat/widget-tools';
import type { WidgetDecisionState } from '@/lib/chat/views';

const MAX_STATE_CHARS = 4_000;

function stateOf(value: unknown): WidgetDecisionState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record: { icon?: unknown; headline?: unknown; detail?: unknown; links?: unknown } = value;
  if (record.icon !== 'sent' && record.icon !== 'cancelled') return null;
  if (typeof record.headline !== 'string') return null;
  const links = Array.isArray(record.links)
    ? record.links.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const link: { label?: unknown; href?: unknown } = entry;
        return typeof link.label === 'string' && typeof link.href === 'string'
          ? [{ label: link.label, href: link.href }]
          : [];
      })
    : [];
  return {
    icon: record.icon,
    headline: record.headline,
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const chat = await getChatForOwner(db, session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');

  const body = await readJsonBody(request);
  const stateKey = typeof body.stateKey === 'string' ? body.stateKey : '';
  const decision = body.decision === 'confirmed' || body.decision === 'cancelled'
    ? body.decision
    : null;
  const state = JSON.stringify(body.state).length <= MAX_STATE_CHARS ? stateOf(body.state) : null;
  if (!stateKey || !decision || !state) {
    return jsonError(400, 'invalid', 'stateKey, decision and state are required.');
  }

  const recorded = await recordWidgetDecision(db, {
    chatId: chat.id,
    subject: session.subject,
    stateKey,
    decision,
    state,
  });
  if (!recorded.ok) return jsonError(400, 'invalid', 'The decision could not be recorded.');
  return NextResponse.json({ ok: true });
}
