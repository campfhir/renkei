import { notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { requireAuth } from '@/lib/require-auth';
import { getUtilizationReport } from './actions';
import { DEFAULT_PERIOD_KEY } from './window';
import { headers } from 'next/headers';
import UtilizationViewer from './utilization-viewer';

/**
 * Server-render the default window, then hand off to the viewer, which
 * calls `getUtilizationReport` for every period change — the tools page's
 * shape. The subject is decided inside the action from the session.
 */
export default async function UtilizationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  await requireAuth(tenant.id, `/${slug}/utilization`);

  // The first render has no browser to ask, so it uses the zone the
  // viewer's proxy or CDN forwards when one does; the client re-fetches in
  // its own zone the moment the period changes, and the footnote names
  // the zone in use either way.
  const forwardedZone = (await headers()).get('x-vercel-ip-timezone') ?? undefined;
  const initial = await getUtilizationReport(tenant.id, DEFAULT_PERIOD_KEY, forwardedZone);

  return <UtilizationViewer slug={slug} tenantId={tenant.id} initial={initial} />;
}
