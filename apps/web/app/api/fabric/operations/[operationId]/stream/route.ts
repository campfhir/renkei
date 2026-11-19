/**
 * The operation page's live view: one Fabric operation, pushed to the
 * browser as it changes. The run page's stream (agents/…/runs/…/stream),
 * with one difference: nothing else moves this row while the person
 * watches — the worker's sweep skips an operation watched in the last
 * WATCH_WINDOW — so this route is also what asks Fabric, whenever the row
 * says it is due (Fabric's Retry-After). Each tick also records that the
 * person is watching, which is what keeps the sweep (and its
 * notification) away; close the page and within the window the sweep
 * takes over and tells them when it ends.
 *
 * `runtime = 'nodejs'`: a stream held open for minutes is not what the
 * edge runtime is for.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { currentOperation, fabricAccessFor } from '@/lib/fabric/server';
import { operationView, type FabricOperationView } from '@/lib/fabric/operation-view';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';

/** How often the stream re-reads the row (and asks Fabric when it is due). */
const TICK_MS = 2_000;
/** A stream is closed after this long; the browser reconnects if still open. */
const MAX_STREAM_MS = 10 * 60 * 1000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> }
): Promise<Response> {
  const { operationId } = await params;
  if (!isUuid(operationId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const subject = session.subject;
  const store = getDataStore().fabricOperations;
  const initial = await store.find(subject, operationId);
  if (!initial) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const access = initial.status === 'running' ? await fabricAccessFor(subject) : undefined;

  const encoder = new TextEncoder();
  let closed = false;
  let lastSent = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const openedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed from the other end.
        }
      };
      const send = (view: FabricOperationView) => {
        if (closed) return;
        const payload = JSON.stringify(view);
        if (payload === lastSent) {
          controller.enqueue(encoder.encode(': ping\n\n'));
          return;
        }
        lastSent = payload;
        controller.enqueue(encoder.encode(`event: operation\ndata: ${payload}\n\n`));
        if (view.status !== 'running') close();
      };
      const tick = async () => {
        if (closed) return;
        try {
          const operation = await currentOperation(subject, operationId, access);
          if (!operation) return close();
          if (operation.status === 'running')
            await store.markWatched(subject, operationId, new Date());
          send(operationView(operation));
        } catch {
          // One bad tick is not the end of the stream; the next one retries.
        }
        if (closed) return;
        if (Date.now() - openedAt > MAX_STREAM_MS) return close();
        timer = setTimeout(() => void tick(), TICK_MS);
      };
      void tick();
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
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
