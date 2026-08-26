/**
 * Destructive entry operations from the files browser — the REST twins of
 * fileshare_move_entry / fileshare_rename_entry / the delete confirm, all
 * through the same shared gate (`destructiveRefusal`), so what a person
 * may do here is exactly what a model acting for them could.
 *
 * DELETE removes a file or an EMPTY folder (a non-empty one is a 409, not
 * a tree delete). POST carries {op:'move'|'rename'} — one route because
 * both are the rename primitive under different spellings of the
 * destination.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  childPath,
  effectiveAccess,
  normalizePath,
  openBackend,
  parentPath,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import type { ShareBackend } from '@renkei/connector-fileshares';
import type { Result } from '@campfhir/safe-functions/types';
import { getSessionFromRequest } from '@/lib/session';
import {
  backendStatus,
  destructiveRefusal,
  isRefusal,
  resolveShareAccess,
} from '@/lib/file-shares/access';
import type { ShareAccess } from '@/lib/file-shares/access';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withBackend<T>(
  shareId: string,
  access: ShareAccess,
  work: (backend: ShareBackend) => Promise<Result<T, string>>
): Promise<Result<T, string>> {
  return withSessionLimits(shareId, 'interactive', async () => {
    const opened = await openBackend(access.ctx.share, access.credentials);
    if (!opened.ok) return opened;
    try {
      return await work(opened.val);
    } finally {
      await opened.val.close();
    }
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveShareAccess(tenantId, shareId, session.subject);
  if (isRefusal(access)) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const path = normalizePath(request.nextUrl.searchParams.get('path') ?? '');
  if (!path.ok || path.val === '/') {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }
  const refusal = await destructiveRefusal(tenantId, access.ctx, path.val, 'delete');
  if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });

  const removed = await withBackend(shareId, access, async (backend) => {
    const stats = await backend.stat(path.val);
    if (!stats.ok) return stats;
    return backend.remove(path.val, stats.val.kind);
  });
  if (!removed.ok) {
    return NextResponse.json(
      { error: removed.err.message ?? removed.err.type },
      { status: backendStatus(removed.err.type) }
    );
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

  const access = await resolveShareAccess(tenantId, shareId, session.subject);
  if (isRefusal(access)) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body))
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  const op = body.op;
  if (op !== 'move' && op !== 'rename') {
    return NextResponse.json({ error: "op must be 'move' or 'rename'" }, { status: 400 });
  }

  const from = normalizePath(typeof body.from === 'string' ? body.from : '');
  if (!from.ok || from.val === '/') {
    return NextResponse.json({ error: 'Unusable source path' }, { status: 400 });
  }

  let destination: string;
  if (op === 'move') {
    const toFolder = normalizePath(typeof body.toFolder === 'string' ? body.toFolder : '');
    if (!toFolder.ok) return NextResponse.json({ error: 'Unusable destination' }, { status: 400 });
    destination = childPath(toFolder.val, from.val.slice(from.val.lastIndexOf('/') + 1));
  } else {
    const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
    if (!newName || newName.includes('/') || newName.includes('\\') || newName === '..') {
      return NextResponse.json(
        { error: 'The new name must be a plain name with no path separators' },
        { status: 400 }
      );
    }
    destination = childPath(parentPath(from.val), newName);
  }
  if (destination === from.val) return NextResponse.json({ ok: true, path: destination });

  const refusal = await destructiveRefusal(tenantId, access.ctx, from.val, op);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });
  if (effectiveAccess(access.ctx, destination) !== 'read_write') {
    return NextResponse.json(
      { error: 'You do not have read/write access at the destination' },
      { status: 403 }
    );
  }

  const renamed = await withBackend(shareId, access, (backend) =>
    backend.rename(from.val, destination)
  );
  if (!renamed.ok) {
    return NextResponse.json(
      { error: renamed.err.message ?? renamed.err.type },
      { status: backendStatus(renamed.err.type) }
    );
  }
  return NextResponse.json({ ok: true, path: destination });
}
