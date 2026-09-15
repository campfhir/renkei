import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getOrgUsageReport } from './actions';
import { DEFAULT_PERIOD_KEY } from './window';
import OrgUsageViewer from './usage-viewer';

/**
 * Organization Usage: the operator's tenant-wide counterpart to "My
 * usage" — every surface's token spend, who's actually using it, and
 * which agents cost the most or do the most work per token. Operator-only,
 * checked here and again inside every server action the viewer calls.
 */
export default async function OrgUsagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  // The first render has no browser to ask, so it uses the zone the
  // viewer's proxy or CDN forwards when one does; the client re-fetches in
  // its own zone the moment the period changes.
  const forwardedZone = (await headers()).get('x-vercel-ip-timezone') ?? undefined;
  const initial = await getOrgUsageReport(tenant.id, DEFAULT_PERIOD_KEY, forwardedZone);

  return <OrgUsageViewer slug={slug} tenantId={tenant.id} initial={initial} />;
}
