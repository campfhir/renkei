import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { signInUrl } from '@/lib/sign-in-url';
import { searchLogs } from './actions';
import LogsViewer from './logs-viewer';
import { defaultLogWindow, DEFAULT_LOG_LEVELS } from './window';

/**
 * Server-render the first page of logs, then hand off to the viewer, which
 * calls `searchLogs` for every subsequent filter change. Role and scope are
 * resolved inside that action, so there is nothing to decide here.
 */
export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ accountId?: string }>;
}) {
  const { slug } = await params;
  const { accountId } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  // Computed here, not in both places: the server render and the picker the
  // client seeds from have to agree about what is being searched.
  const window = defaultLogWindow();

  const initial = await searchLogs(tenant.id, {
    expr: null,
    levels: DEFAULT_LOG_LEVELS,
    start: window.start,
    end: window.end,
    sort: 'desc',
    accountId: accountId ?? null,
  });

  // Arriving with a dead session cookie is normal. Send them to authenticate
  // rather than rendering a page that says "sign in" without being able to
  // start it.
  if (initial.signedOut) {
    redirect(signInUrl(tenant.id, `/${slug}/logs`));
  }

  return (
    <LogsViewer
      slug={slug}
      tenantId={tenant.id}
      accountId={accountId ?? null}
      initial={initial}
      initialWindow={window}
    />
  );
}
