/**
 * The admin run detail page's live view — same mechanism as the owner
 * route (apps/web/app/api/agents/[agentId]/runs/[runId]/stream):
 * this route polls the database on the server, and only pushes an SSE
 * message to the browser when a re-read actually differs. Against the
 * admin's already-redacted projection (getRunForAdmin) and no pause card,
 * since oversight is read-only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getRunForAdmin, type RunDetail } from '@/lib/agents/runs-view';
import { isRunSettled } from '@/lib/agents/run-labels';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';

const POLL_MS = 2_000;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string; runId: string }> }
): Promise<Response> {
  const { agentId, runId } = await params;
  if (!isUuid(agentId) || !isUuid(runId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const initial = await getRunForAdmin(agentId, runId);
  if (!initial) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;
  let lastSent = '';
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

      const send = (run: RunDetail) => {
        if (closed) return;
        const payload = JSON.stringify({ run });
        if (payload === lastSent) {
          controller.enqueue(encoder.encode(': ping\n\n'));
          return;
        }
        lastSent = payload;
        controller.enqueue(encoder.encode(`event: run\ndata: ${payload}\n\n`));
        if (isRunSettled(run.status)) close();
      };

      send(initial);
      if (closed) return;

      timer = setInterval(() => {
        if (closed) return;
        void getRunForAdmin(agentId, runId).then((run) => {
          if (run) send(run);
        });
      }, POLL_MS);
    },
    cancel() {
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
      'X-Accel-Buffering': 'no',
    },
  });
}
