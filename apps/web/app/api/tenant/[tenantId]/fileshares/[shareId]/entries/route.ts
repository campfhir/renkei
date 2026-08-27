/**
 * Destructive entry operations from the files browser — the REST twins of
 * fileshare_move_entry / fileshare_rename_entry / the delete confirm. The
 * fileshare worker runs every operation on the caller's own credential,
 * so what a person may do here is exactly what their account may do on
 * the file server (and never clobbers; empty folders only for delete).
 *
 * DELETE removes a file or an EMPTY folder (a non-empty one is a 409, not
 * a tree delete). POST carries {op:'move'|'rename'} — one route because
 * both are the rename primitive under different spellings of the
 * destination.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import {
  clientFailure,
  fsMoveEntry,
  fsRemoveEntry,
  fsRenameEntry,
} from '@/lib/file-shares/service-client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const path = request.nextUrl.searchParams.get('path') ?? '';
  const removed = await fsRemoveEntry({ tenantId, shareId, subject: session.subject }, path);
  if (!removed.ok) {
    const failure = clientFailure(removed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body))
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  const op = body.op;
  if (op !== 'move' && op !== 'rename') {
    return NextResponse.json({ error: "op must be 'move' or 'rename'" }, { status: 400 });
  }
  const from = typeof body.from === 'string' ? body.from : '';
  if (!from) return NextResponse.json({ error: 'Unusable source path' }, { status: 400 });

  const target = { tenantId, shareId, subject: session.subject };
  const moved =
    op === 'move'
      ? await fsMoveEntry(target, from, typeof body.toFolder === 'string' ? body.toFolder : '')
      : await fsRenameEntry(target, from, typeof body.newName === 'string' ? body.newName : '');
  if (!moved.ok) {
    const failure = clientFailure(moved.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ ok: true, path: moved.val.path });
}
