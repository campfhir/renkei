import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { dismissBulkJob } from '@/lib/chat/artifact-bulk-job';

export const runtime = 'nodejs';

type Params = { params: Promise<{ jobId: string }> };

/** DELETE: the person closes a finished job's line on the library page. */
export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { jobId } = await params;
  if (!(await dismissBulkJob(ready.context.session.subject, jobId))) {
    return jsonError(404, 'not-found', 'No such finished job');
  }
  return NextResponse.json({ ok: true });
}
