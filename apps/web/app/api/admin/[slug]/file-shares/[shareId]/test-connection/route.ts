/**
 * Prove a share's connection details actually reach a server — with the
 * STORED credential, or with credential fields from the body so an admin
 * can test before saving. Lists the root and reports the entry count;
 * never echoes a credential in any direction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  decryptCredentials,
  getShare,
  openBackend,
  readCredentialCiphertext,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import type { ShareCredentials } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseSharePayload } from '@/lib/file-shares/parse';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // The body is the same share payload the config form holds, so unsaved
  // edits (host, root, credentials) are what gets tested — falling back to
  // the stored share and credential where the body carries none.
  const body: unknown = await request.json().catch(() => null);
  const parsed = body === null ? null : parseSharePayload(body);
  if (parsed && 'error' in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error });
  }

  const stored = await getShare(dbResult.val, tenant.id, shareId);
  if (!stored.ok) return NextResponse.json({ error: 'Could not read the share' }, { status: 500 });
  const storedRow = stored.val;

  let summary;
  if (parsed) {
    summary = {
      id: storedRow?.summary.id ?? 'unsaved',
      name: parsed.input.name,
      protocol: parsed.input.protocol,
      host: parsed.input.host,
      port: parsed.input.port,
      shareName: parsed.input.shareName,
      rootPath: parsed.input.rootPath,
      caseInsensitive: parsed.input.caseInsensitive,
      maxAccess: parsed.input.maxAccess,
      enabled: true,
      hasCredentials: true,
    };
  } else if (storedRow) {
    summary = storedRow.summary;
  } else {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let credentials: ShareCredentials | null = parsed?.credentials ?? null;
  if (!credentials) {
    const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!keyResult.ok) {
      return NextResponse.json({ error: 'Encryption key unavailable' }, { status: 500 });
    }
    const ciphertext = await readCredentialCiphertext(dbResult.val, tenant.id, shareId);
    if (!ciphertext.ok || ciphertext.val === null) {
      return NextResponse.json({
        ok: false,
        error: 'No credentials stored yet — enter them first.',
      });
    }
    const opened = decryptCredentials(ciphertext.val, keyResult.val);
    if (!opened.ok) {
      return NextResponse.json({
        ok: false,
        error: 'Stored credentials cannot be read — re-enter them.',
      });
    }
    credentials = opened.val;
  }

  const listed = await withSessionLimits(summary.id, 'interactive', async () => {
    const backend = await openBackend(summary, credentials);
    if (!backend.ok) return backend;
    try {
      return await backend.val.list('/');
    } finally {
      await backend.val.close();
    }
  });
  if (!listed.ok) {
    return NextResponse.json({
      ok: false,
      error: listed.err.message ?? `Connection failed (${listed.err.type})`,
    });
  }
  return NextResponse.json({ ok: true, entries: listed.val.length });
}
