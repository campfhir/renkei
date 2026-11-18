/**
 * A host's CI service account (lib/ci/accounts.ts) — operators only. The
 * secret is write-only: a blank one on save keeps what is stored.
 *
 *   PUT /api/admin/ci-accounts/bitbucket { workspace, auth: 'bearer' | 'basic', email?, token? }
 *   PUT /api/admin/ci-accounts/github    { org, appId, privateKey? }
 *   DELETE                               → forgets the account
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { removeAccount, saveBitbucketAccount, saveGithubAccount } from '@/lib/ci/accounts';
import { forgetRunners } from '@/lib/ci/runners';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

type Params = { params: Promise<{ host: string }> };
const HOST_NAMES = { bitbucket: 'Bitbucket', github: 'GitHub' } as const;

function hostOf(value: string): 'bitbucket' | 'github' | null {
  return value === 'bitbucket' || value === 'github' ? value : null;
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const host = hostOf((await params).host);
  if (!host) return NextResponse.json({ error: 'Not a host' }, { status: 404 });
  const body: unknown = await request.json().catch(() => null);
  const saved =
    host === 'bitbucket' ? await saveBitbucketAccount(body) : await saveGithubAccount(body);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  forgetRunners();
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.account_saved',
    targetKind: 'ci_account',
    targetLabel: HOST_NAMES[host],
    details: { host },
  });
  logger.info('{actor} saved the {host} CI service account', {
    component: 'api/admin/ci-accounts',
    ...who(session),
    host: HOST_NAMES[host],
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const host = hostOf((await params).host);
  if (!host) return NextResponse.json({ error: 'Not a host' }, { status: 404 });
  const removed = await removeAccount(host);
  if (!removed.ok) return NextResponse.json({ error: removed.error }, { status: 500 });
  forgetRunners();
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.account_removed',
    targetKind: 'ci_account',
    targetLabel: HOST_NAMES[host],
    details: { host },
  });
  logger.info('{actor} removed the {host} CI service account', {
    component: 'api/admin/ci-accounts',
    ...who(session),
    host: HOST_NAMES[host],
  });
  return NextResponse.json({ ok: true });
}
