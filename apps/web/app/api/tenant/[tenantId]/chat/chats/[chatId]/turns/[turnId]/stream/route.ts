/**
 * A turn, live: one `text/event-stream` GET per open thread.
 *
 * Two paths behind one URL. When the turn is running in THIS process,
 * the route subscribes to its channel and forwards events as they
 * happen, replaying from the browser's `Last-Event-ID` after a
 * reconnect. Otherwise — another replica is running it, the process
 * restarted, or the ring no longer reaches back far enough — the route
 * sends the turn's rows as a snapshot and re-reads them every second
 * until the turn settles, emitting only when something changed (the run
 * stream's `lastSent` trick). Same events, same reducer, coarser deltas.
 *
 * `runtime = 'nodejs'`: a ReadableStream held open for minutes is what
 * the edge runtime's budget is not built for.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { getTurn, isTurnSettled, toTurnView } from '@/lib/chat/turns';
import { listTurnMessages, toMessageView } from '@/lib/chat/messages';
import { getTurnChannel } from '@/lib/chat/turn-events';
import type { ChatStreamEvent } from '@/lib/chat/stream-events';

export const runtime = 'nodejs';

const POLL_MS = 1_000;
const PING_MS = 15_000;

async function snapshotOf(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  turnId: string
): Promise<ChatStreamEvent | null> {
  const turn = await getTurn(db, tenantId, chatId, turnId);
  if (!turn) return null;
  const messages = await listTurnMessages(db, tenantId, turnId);
  return { type: 'snapshot', turn: toTurnView(turn), messages: messages.map(toMessageView) };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string; turnId: string }> }
): Promise<Response> {
  const { tenantId, chatId, turnId } = await params;
  if (!isUuid(chatId) || !isUuid(turnId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveChatAccess(db, tenantId, session.subject, chatId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const turn = await getTurn(db, tenantId, chatId, turnId);
  if (!turn) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const lastEventId = request.headers.get('last-event-id');
  const fromSeq = lastEventId && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0;

  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (seq: number | null, event: ChatStreamEvent) => {
        write(
          `event: turn\n${seq !== null ? `id: ${seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`
        );
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup?.();
        try {
          controller.close();
        } catch {
          // Already closed from the other end.
        }
      };
      const ping = setInterval(() => write(': ping\n\n'), PING_MS);

      const channel = getTurnChannel(turnId);
      const unsubscribe = channel
        ? channel.subscribe(fromSeq, ({ seq, event }) => {
            send(seq, event);
            if (event.type === 'turn_end') close();
          })
        : null;
      if (channel && unsubscribe) {
        cleanup = () => {
          clearInterval(ping);
          unsubscribe();
        };
        // A channel that closed before we subscribed already replayed its
        // ending; a turn settled in the database says the same thing.
        if (channel.closed || isTurnSettled(turn.status)) {
          const snapshot = await snapshotOf(db, tenantId, chatId, turnId);
          if (snapshot) send(null, snapshot);
          send(null, { type: 'turn_end', turnId, status: turn.status, error: turn.error });
          close();
        }
        return;
      }

      // Snapshot path. Ids are omitted on purpose: a later reconnect then
      // replays from 0, which lands here again rather than in a ring that
      // never held these events.
      let lastSent = '';
      const tick = async () => {
        if (closed) return;
        const snapshot = await snapshotOf(db, tenantId, chatId, turnId);
        if (!snapshot || snapshot.type !== 'snapshot') {
          close();
          return;
        }
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastSent) {
          lastSent = serialized;
          send(null, snapshot);
        }
        if (isTurnSettled(snapshot.turn.status)) {
          send(null, {
            type: 'turn_end',
            turnId,
            status: snapshot.turn.status,
            error: snapshot.turn.error,
          });
          close();
        }
      };
      const poll = setInterval(() => void tick(), POLL_MS);
      cleanup = () => {
        clearInterval(ping);
        clearInterval(poll);
      };
      await tick();
    },
    cancel() {
      closed = true;
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering on nginx-fronted deployments.
      'X-Accel-Buffering': 'no',
    },
  });
}
