import React from 'react';
import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { getPublicBaseUrl } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ConnectorForms from './connector-forms';

/**
 * The deployment's public origin, so the forms can show concrete
 * copy-pasteable callback and webhook URLs instead of "this deployment's
 * origin + …". Mirrors getOrigin's resolution order (lib/get-origin.ts):
 * PUBLIC_BASE_URL when declared, else the trusted reverse proxy's
 * X-Forwarded-* headers. Null when neither is available — the forms then
 * fall back to abstract phrasing.
 */
async function resolveOrigin(): Promise<string | null> {
  const configured = getPublicBaseUrl();
  if (configured) return configured;
  const requestHeaders = await headers();
  const proto = requestHeaders.get('x-forwarded-proto');
  const host = requestHeaders.get('x-forwarded-host');
  if (proto && host) return `${proto}://${host}`;
  return null;
}

/**
 * Org-admin provisioning of connectors (RENKEI.md Decision #13): the
 * Atlassian OAuth app, the WebEx bot, the embedding provider. This page is
 * the UI over the /api/admin/[slug]/connectors routes that already existed —
 * until now the only way to register an app was a hand-written PUT from a
 * devtools console, which is what docs/ui-shell-brief.md was written about.
 */
export default async function AdminConnectorsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }
  const origin = await resolveOrigin();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Connector setup</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What your organization runs, with what credentials. Secrets are sealed with the deployment
        key and never shown again after saving.
      </p>
      <ConnectorForms slug={slug} tenantId={tenantRef.id} origin={origin} />
    </div>
  );
}
