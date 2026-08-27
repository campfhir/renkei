import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import FilesBrowser from './files-browser';

/**
 * The files browser: the human face of the same seam the fileshare_* tools
 * ride. Everything on this page runs on the caller's own stored share
 * credentials through the tenant REST routes, so what a person can see and
 * do here is exactly what their account can do on the file server.
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
        Org network shares, browsed with your own credentials — connect a share on the Connectors
        page and it opens here. What you can see and change is what your account may on the file
        server.
      </p>
      <FilesBrowser tenantId={tenant.id} />
    </div>
  );
}
