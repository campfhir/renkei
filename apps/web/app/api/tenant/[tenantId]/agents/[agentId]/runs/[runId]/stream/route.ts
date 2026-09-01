/**
 * The run detail page's live view: one run, pushed to the browser as it
 * changes, instead of the page (or the browser) polling for it.
 *
 * The polling still happens — nothing tells this route when a run changes,
 * so it re-reads the run every POLL_MS — but it happens HERE, once, on the
 * server, against the database directly. The browser never sees a poll: it
 * holds one long-lived `text/event-stream` GET and only receives a message
 * when the re-read actually differs from what it already has. That is the
 * whole fix over the page polling itself: no client-visible interval, no
 * full-page `router.refresh()`, and the DB load is one query per open run
 * page per tick rather than one per browser tab's own timer racing to
 * reload the entire page.
 *
 * `runtime = 'nodejs'` — a Route Handler can run on the edge runtime by
 * default, but a `ReadableStream` kept open with `setInterval` for minutes
 * at a time is exactly what the edge runtime's short execution budget is
 * not built for.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { getOwnerRunPageData, type OwnerRunPageData } from '@/lib/agents/run-page-data';
import { isRunSettled } from '@/lib/agents/run-labels';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';

// Short enough that a change reads as instant; long enough that watching a
// run stay open all afternoon costs one query every couple of seconds, not
// a busy loop.
const POLL_MS = 2_000;

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
  // Shared with `cancel()` below, so a client disconnect stops the same
  // timer a settled run's own `close()` does.
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed from the other end — nothing left to do.
        }
      };

      const send = (data: OwnerRunPageData) => {
        if (closed) return;
        const payload = JSON.stringify(data);
        if (payload === lastSent) {
          // Nothing changed — a comment line, not a `run` event, so the
          // connection reads as alive to any proxy in front of it without
          // giving the browser a duplicate to parse.
          controller.enqueue(encoder.encode(': ping\n\n'));
          return;
        }
        lastSent = payload;
        controller.enqueue(encoder.encode(`event: run\ndata: ${payload}\n\n`));
        if (isRunSettled(data.run.status)) close();
      };

      send(initial);
      if (closed) return;

      timer = setInterval(() => {
        if (closed) return;
        void getOwnerRunPageData(
          db,
          tenantId,
          access.ownerSubject,
          access.viewerIsOwner,
          agentId,
          runId
        ).then((data) => {
          if (data) send(data);
        });
      }, POLL_MS);
    },
    cancel() {
      // The browser navigated away or the EventSource was closed. Mirrors
      // `close()` above minus the `controller.close()` call — the
      // controller is already gone by the time `cancel` runs.
      if (closed) return;
      closed = true;
      clearInterval(timer);
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
