/**
 * Org-admin configuration of the organization's file storage — the Azure
 * Blob account chat uploads and the files tools produce are kept in.
 * GET reports presence only; the account key never leaves the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit-events';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseStorageInput, readStorage, saveStorage } from '@/lib/storage-admin';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const view = await readStorage();
  if (view === 'ERROR') {
    logger.error(
      '{actor} opened the file storage settings, but they could not be read; the page got a 500',
      {
        component: 'api/admin/storage',
        ...who(access),
      }
    );
    return NextResponse.json(
      { error: 'Could not read the storage configuration' },
      { status: 500 }
    );
  }
  return NextResponse.json(view);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const input = parseStorageInput(await request.json().catch(() => null));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  const saved = await saveStorage(input);
  if (typeof saved === 'string') {
    if (!saved.startsWith('The ')) {
      logger.error('{actor} saved the file storage settings, but they were not saved: {error}', {
        component: 'api/admin/storage',
        ...who(access),
        error: saved,
      });
    }
    return NextResponse.json({ error: saved }, { status: saved.startsWith('The ') ? 400 : 500 });
  }
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'storage.configured',
    targetKind: 'settings',
    targetLabel: 'blob storage',
    // Where it points, never the key.
    details: { account: input.account, container: input.container, endpoint: input.endpoint },
  });
  return NextResponse.json(saved);
}
