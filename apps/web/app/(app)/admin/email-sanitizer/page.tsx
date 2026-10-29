import React from 'react';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import RuleForms from './rule-forms';
import SuggestRulesPanel from './suggest-rules-panel';
import CleanerScripts from './cleaner-scripts';

/**
 * Org-admin configuration for the email sanitizer (see
 * packages/email-sanitizer): classifier rules (sender/domain/subject →
 * category) and read-only template health. Deliberately content-free —
 * there is no message content, excerpt, or per-user classification on this
 * page. Each user reviews and corrects their own mail on their private
 * /[slug]/mail-review page instead; that boundary is the whole point of the
 * feature's design, not an oversight.
 */
export default async function AdminEmailSanitizerPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  // Rule suggestions need the org model; without one the feature is simply
  // absent — no teaser for a button that could only fail.
  const modelRead = await wrapAsync(
    () => getDataStore().emailSanitizer.hasEnabledChatModel(),
    'DB_ERROR' as const
  );
  const hasOrgModel = modelRead.ok && modelRead.val;

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
      {hasOrgModel && <SuggestRulesPanel />}
      <RuleForms />
      <CleanerScripts canSuggest={hasOrgModel} />
    </div>
  );
}
