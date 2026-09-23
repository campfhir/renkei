import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { sandboxServicesEnabled } from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ImageRuleForms from './image-rule-forms';

/**
 * The org's service image allow-list (code_service_image_rules): which
 * container images a code project's chat may start beside its checkout
 * — whole registries, namespaces on one, or single repositories — and
 * the credential a private registry is pulled with. Every tenant starts
 * with a handful of public images; an operator adds their own registry,
 * removes what they do not want, or puts the defaults back.
 */
export default async function AdminCodeServicesPage({
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
  const enabled = sandboxServicesEnabled();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Code services</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The container images a code project&rsquo;s chat may start beside its checkout &mdash; a
        database or a cache for the project&rsquo;s tests. A rule allows a whole registry (
        <code>myorg.azurecr.io</code>), a namespace on one (<code>myorg.azurecr.io/platform/*</code>
        ) or a single repository at any tag (<code>postgres</code>, <code>pgvector/pgvector</code>
        ). A private registry&rsquo;s rule carries the credential it is pulled with; the secret is
        sealed on the sandbox worker and never shown again.
      </p>
      {enabled ? (
        <ImageRuleForms slug={slug} />
      ) : (
        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          Code project services are not enabled on this deployment. Set{' '}
          <code>SANDBOX_SERVICES_ENABLED=true</code> on the web app and the sandbox worker, and give
          the worker its Docker engine (see DEPLOYMENT.md), to turn them on.
        </p>
      )}
    </div>
  );
}
