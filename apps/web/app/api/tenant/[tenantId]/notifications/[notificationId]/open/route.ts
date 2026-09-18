/**
 * Where a click on an OS banner lands (public/sw.js → this): the row is
 * marked read — tapping is reading, the same rule the notifications page
 * applies — and the browser is sent on to what the notification is about:
 * the source application when the row links to one and the person has
 * "open in the source application" on (their default), else the thing's
 * place in Renkei (lib/notifications/targets.ts).
 *
 * A GET on purpose: a banner click is a top-level navigation, not a fetch
 * the worker makes, so the session cookie rides along and a signed-out
 * browser is sent to sign in and back here. Strictly the caller's own
 * row — a borrowed id from someone else's feed is a 404.
 *
 * The preference is read at click time, not send time: the push carried
 * only a hint for the worker about how to open the URL.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { isWebUrl } from '@renkei/notifications';
import { getSessionFromRequest } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { isUuid } from '@/lib/uuid';
import { notificationTarget } from '@/lib/notifications/targets';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; notificationId: string }> }
): Promise<Response> {
  const { tenantId, notificationId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.redirect(new URL(signInUrl(tenantId, request.nextUrl.pathname), request.url));
  }
  if (!isUuid(notificationId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const [row, tenant] = await Promise.all([
    db
      .selectFrom('agent_notifications')
      .select(['id', 'kind', 'ref_url', 'agent_id', 'run_id', 'meta'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', session.subject)
      .where('id', '=', notificationId)
      .executeTakeFirst(),
    db.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirst(),
  ]);
  if (!row || !tenant) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await db
    .updateTable('agent_notifications')
    .set({ read_at: new Date() })
    .where('id', '=', row.id)
    .where('read_at', 'is', null)
    .execute();

  const prefs = await getNotificationPrefs(tenantId, session.subject, { fresh: true });
  const target = notificationTarget(
    tenant.slug,
    {
      kind: row.kind,
      refUrl: row.ref_url,
      agentId: row.agent_id,
      runId: row.run_id,
      meta: row.meta ?? null,
    },
    prefs.openInSourceApp
  );

  if (!target.external || isWebUrl(target.url)) {
    return NextResponse.redirect(new URL(target.url, request.url), 302);
  }
  // A custom scheme (webexteams://…) is not something every browser follows
  // a redirect into; a page that navigates itself is, and it leaves a way
  // back for a machine with no such application installed.
  return new NextResponse(openerPage(target.url, `/${tenant.slug}/notifications`), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openerPage(target: string, fallback: string): string {
  const safeTarget = escapeHtml(target);
  const safeFallback = escapeHtml(fallback);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening…</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; color: #374151; background: #fff; }
  a { color: #2563eb; }
  @media (prefers-color-scheme: dark) { body { color: #d1d5db; background: #030712; } }
</style>
</head>
<body>
<p>Opening it in its application…</p>
<p>If nothing happened, <a href="${safeTarget}">open it</a> — or go <a href="${safeFallback}">back to your notifications</a>.</p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>
`;
}
