/**
 * Start a batch job from a plain form — the REST twin of the
 * batch_start_document_pipeline MCP tool, for a human instead of an agent.
 * Only document-ocr-pipeline exists today; a future batch kind adds a
 * `kind` field here the same way it would add one to the MCP tool.
 *
 * Shares startDocumentOcrPipeline with the MCP tool so the two paths cannot
 * drift on what a batch's config looks like.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { listConnectedShares } from '@renkei/connector-fileshares';
import { startDocumentOcrPipeline } from '@/lib/batch-jobs/start-document-ocr-pipeline';
import { parseGrouping } from '@/lib/batch-jobs/grouping';
import {
  AFTER_PROCESSING_SHAPE,
  afterProcessingRefusal,
  parseAfterProcessing,
  parseSkipProcessed,
} from '@/lib/batch-jobs/pipeline-options';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  const shareId = typeof body.shareId === 'string' ? body.shareId : '';
  if (!shareId) return NextResponse.json({ error: 'shareId is required' }, { status: 400 });
  const path = typeof body.path === 'string' && body.path ? body.path : '/';
  const grouping = parseGrouping(body.grouping);
  if (!grouping) {
    return NextResponse.json(
      {
        error:
          'grouping must be {strategy:"whole-file"} or {strategy:"filename-pattern", pattern} ' +
          'with named captures ?<documentKey> and ?<page>',
      },
      { status: 400 }
    );
  }
  const skipProcessed = parseSkipProcessed(body.skipProcessed);
  if (skipProcessed === null) {
    return NextResponse.json({ error: 'skipProcessed must be a boolean' }, { status: 400 });
  }
  const afterProcessing = parseAfterProcessing(body.afterProcessing);
  if (!afterProcessing) return NextResponse.json({ error: AFTER_PROCESSING_SHAPE }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // The share must exist and this caller must have connected their own
  // credentials to it — otherwise discovery would just fail later with a
  // less helpful error once the batch is already running — and moving or
  // deleting on it must be within what they allowed on the Connectors page.
  const shares = await listConnectedShares(dbResult.val, tenantId, session.subject);
  if (!shares.ok) return NextResponse.json({ error: 'Could not read your file shares' }, { status: 500 });
  const refusal = afterProcessingRefusal(shares.val, shareId, afterProcessing);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  const batch = await startDocumentOcrPipeline(dbResult.val, {
    tenantId,
    subject: session.subject,
    name,
    shareId,
    path,
    grouping,
    skipProcessed,
    afterProcessing,
  });

  return NextResponse.json({ batchId: batch.id }, { status: 201 });
}
