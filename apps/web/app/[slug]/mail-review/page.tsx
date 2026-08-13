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
      <h1 className="mb-1 text-xl font-bold">Mail classification</h1>
      <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
        A record of how your own mail was classified before indexing — human correspondence, a
        system notification, or marketing (excluded from indexing entirely).{' '}
        <strong>Nothing here is waiting on you</strong>: every message listed has already been
        processed. Browse it only if something looks miscategorized.
      </p>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        This is private to you; nobody else, including an org-admin, can see it. Correcting a
        message re-processes it automatically. If a whole category of mail is landing in the wrong
        place, an org-admin can fix it for everyone at once under Connector setup → Email sanitizer,
        rather than correcting messages one at a time here.
      </p>
      <ReviewList tenantId={tenant.id} />
    </div>
  );
}
