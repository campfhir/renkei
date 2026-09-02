import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { signInUrl } from '@/lib/sign-in-url';
import { getUtilizationReport } from './actions';
import { DEFAULT_PERIOD_KEY } from './window';
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

  const initial = await getUtilizationReport(tenant.id, DEFAULT_PERIOD_KEY);
  if (initial.signedOut) {
    redirect(signInUrl(tenant.id, `/${slug}/utilization`));
  }

  return <UtilizationViewer slug={slug} tenantId={tenant.id} initial={initial} />;
}
