import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import RedactionForm from './redaction-form';

/**
 * Org-admin configuration for the redaction gate (see @renkei/redaction).
 *
 * Content-free by construction, like the email sanitizer page next to it: it
 * configures which detectors run, and never shows what any of them matched. A
 * page that displayed examples of caught identifiers would put them back on a
 * screen, in a browser cache, and in a screenshot — undoing the thing it is
 * configuring.
 */
export default async function AdminRedactionPage({
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

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Sensitive data</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Identifiers found in tool results are replaced before they reach a model. Replacement is
        consistent, so the same record number always becomes the same stand-in and a model can still
        tell that two tickets concern one person — without seeing the number.
      </p>
      <RedactionForm slug={slug} />
    </div>
  );
}
