import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import RuleForms from './rule-forms';

/**
 * Org-admin configuration for the email sanitizer (see
 * packages/email-sanitizer): classifier rules (sender/domain/subject →
 * category) and read-only template health. Deliberately content-free —
 * there is no message content, excerpt, or per-user classification on this
 * page. Each user reviews and corrects their own mail on their private
 * /[slug]/mail-review page instead; that boundary is the whole point of the
 * feature's design, not an oversight.
 */
export default async function AdminEmailSanitizerPage({
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
      <h1 className="mb-1 text-xl font-bold">Email sanitizer</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Sender policy for mail cleaned before embedding: which domains, addresses, or subject
        patterns count as system notifications or marketing. Extraction templates for system senders
        are taught from a real message on someone&apos;s own{' '}
        <span className="font-medium">Mail review</span> page, not here — this page never shows
        message content.
      </p>
      <RuleForms slug={slug} />
    </div>
  );
}
