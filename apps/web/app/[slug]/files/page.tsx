import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import FilesBrowser from './files-browser';

/**
 * The files browser: the human face of the same ACL the fileshare_* tools
 * enforce. Everything on this page rides the tenant REST routes, so what a
 * person can see and do here is exactly what a model acting for them
 * could — no more, no less.
 */
export default async function FilesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/files`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Files</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Org network shares you have been granted access to. Each entry shows what you may do with
        it; folders marked &quot;folders below&quot; are on the way to something you can open.
      </p>
      <FilesBrowser tenantId={tenant.id} />
    </div>
  );
}
