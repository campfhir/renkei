import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ReviewList from './review-list';

/**
 * A signed-in user's own mail classification history, and the only place
 * any of it can be corrected. No admin gate, no admin equivalent — see
 * apps/web/app/[slug]/admin/email-sanitizer for the content-free surface
 * org-admins get instead. review-list.tsx resolves and scopes everything
 * through the caller's own session; nothing here takes an identity as input.
 */
export default async function MailReviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/mail-review`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Mail review</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        A spot check on how your own mail is being classified before embedding — human
        correspondence, a system notification, or marketing (excluded entirely). This is private to
        you; nobody else, including an org-admin, can see this list. If something's wrong, remove it
        or reclassify it and it's corrected and re-processed automatically — there's usually not
        much to review here if classification is working well.
      </p>
      <ReviewList tenantId={tenant.id} />
    </div>
  );
}
