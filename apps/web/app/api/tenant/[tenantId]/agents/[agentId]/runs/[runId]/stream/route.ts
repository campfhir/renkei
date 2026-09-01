/**
 * The run detail page's live view: one run, pushed to the browser as it
 * changes, instead of the page polling for it.
 *
 * A plain `text/event-stream` response — one dedicated Postgres LISTEN
 * connection per process (subscribeToRunChanges, packages/db/run-events.ts)
 * fans out to however many of these are open, each re-reading just the one
 * run it cares about through the same redaction-aware projection the page
 * itself uses (getOwnerRunPageData). No WebSocket upgrade, no client-side
 * poll loop: the browser holds one long-lived GET and reacts to whatever
 * arrives on it.
 *
 * `runtime = 'nodejs'` is required, not decorative — `pg`'s LISTEN client
 * needs a real TCP socket, which the edge runtime does not provide.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDatabase, subscribeToRunChanges } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { getOwnerRunPageData, type OwnerRunPageData } from '@/lib/agents/run-page-data';
import { isRunSettled } from '@/lib/agents/run-labels';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;
// A correcting re-read in case a NOTIFY was ever missed — a reconnect
// window on the shared LISTEN connection, say. Long enough to never be
// mistaken for the polling this replaces; short enough that a missed
// notification never leaves the page stale for more than a few refreshes.
const SAFETY_NET_MS = 30_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string; runId: string }> }
): Promise<Response> {
  const { tenantId, agentId, runId } = await params;
  if (!isUuid(agentId) || !isUuid(runId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const initial = await getOwnerRunPageData(
    db,
    tenantId,
    access.ownerSubject,
    access.viewerIsOwner,
    agentId,
    runId
  );
  if (!initial) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;
  let lastSent = '';
  // Shared with `cancel()` below, so a client disconnect tears down the
  // same timers and subscription a settled run's own `close()` does —
  // declared here, above `start`, rather than inside it, for exactly that
  // reason.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let safetyNet: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(safetyNet);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed from the other end — nothing left to do.
        }
      };

      const send = (data: OwnerRunPageData) => {
        if (closed) return;
        const payload = JSON.stringify(data);
        if (payload === lastSent) return;
        lastSent = payload;
        controller.enqueue(encoder.encode(`event: run\ndata: ${payload}\n\n`));
        if (isRunSettled(data.run.status)) close();
      };

      send(initial);
      if (closed) return;

      const refresh = async () => {
        if (closed) return;
        const data = await getOwnerRunPageData(
          db,
          tenantId,
          access.ownerSubject,
          access.viewerIsOwner,
          agentId,
          runId
        );
        if (data) send(data);
      };

      unsubscribe = await subscribeToRunChanges(runId, () => void refresh());
      if (closed) {
        unsubscribe();
        return;
      }

      heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(': ping\n\n'));
      }, HEARTBEAT_MS);
      safetyNet = setInterval(() => void refresh(), SAFETY_NET_MS);
    },
    cancel() {
      // The browser navigated away or the EventSource was closed. Mirrors
      // `close()` above minus the `controller.close()` call — the
      // controller is already gone by the time `cancel` runs.
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(safetyNet);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering on nginx-fronted deployments, which
      // would otherwise hold the whole stream until it ends.
      'X-Accel-Buffering': 'no',
    },
  });
}
