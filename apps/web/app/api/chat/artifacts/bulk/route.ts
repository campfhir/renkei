import type { NextRequest } from 'next/server';
import { NextResponse, after } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import {
  listShownBulkJobs,
  parseBulkRequest,
  queueBulkJob,
  runBulkJob,
} from '@/lib/chat/artifact-bulk-job';

export const runtime = 'nodejs';

/**
 * POST: delete, run OCR on, or add to a project many library files at
 * once. Checked and queued here, answered 202 with the job's id; the job
 * runs after the answer (lib/chat/artifact-bulk-job.ts), and the library
 * shows how far it got.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const parsed = parseBulkRequest(await request.json().catch(() => null));
  if (!parsed.ok) return jsonError(parsed.err.status, parsed.err.code, parsed.err.message);
  const queued = await queueBulkJob(session.subject, parsed.val);
  if (!queued.ok) return jsonError(queued.err.status, queued.err.code, queued.err.message);
  const jobId = queued.val.id;
  after(() => runBulkJob(jobId));
  return NextResponse.json({ ok: true, jobId }, { status: 202 });
}

/** GET: the person's jobs the library shows — live ones, and finished ones not yet closed. */
export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  return NextResponse.json({ jobs: await listShownBulkJobs(ready.context.session.subject) });
}
