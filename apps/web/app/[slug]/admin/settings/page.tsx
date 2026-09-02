import React from 'react';
import Link from 'next/link';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { SettingsForm, type EditableSettings } from './settings-form';

/**
 * The org's operating settings — everything adjustable that has no more
 * specific home. Connector switches live on Connector setup, redaction on
 * Sensitive data, run retention on Agent oversight; this page owns the
 * rest (read-only mode, agent guardrails, token lifetimes, request
 * limits) and says where the others went instead of duplicating them.
 */
export default async function SettingsPage({
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

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Unable to connect to the database. Please try again later.
        </p>
      </div>
    );
  }

  const [settingsResult, oidc] = await Promise.all([
    getOrgSettings(tenantRef.id),
    dbResult.val
      .selectFrom('tenant_oidc')
      .select(['issuer'])
      .where('tenant_id', '=', tenantRef.id)
      .executeTakeFirst(),
  ]);
  if (!settingsResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">Could not read org settings.</p>
      </div>
    );
  }
  const settings = settingsResult.val;
  const initial: EditableSettings = {
    readOnly: settings.readOnly,
    enableDcr: settings.enableDcr,
    maxJqlResults: settings.maxJqlResults,
    maxAttachmentBytes: settings.maxAttachmentBytes,
    rateLimitPerUserPerMinute: settings.rateLimitPerUserPerMinute,
    accessTokenTtlMinutes: settings.accessTokenTtlMinutes,
    authorizationCodeTtlSeconds: settings.authorizationCodeTtlSeconds,
    refreshTokenTtlDays: settings.refreshTokenTtlDays,
    agentMaxChainDepth: settings.agentMaxChainDepth,
    agentRunTimeoutMinutes: settings.agentRunTimeoutMinutes,
    agentMaxStepAttempts: settings.agentMaxStepAttempts,
    agentMaxSteps: settings.agentMaxSteps,
    agentMaxRunsPerDay: settings.agentMaxRunsPerDay,
    agentApprovalMaxWaitDays: settings.agentApprovalMaxWaitDays,
    contentPollMinutes: settings.contentPollMinutes,
    logRetentionDays: settings.logRetentionDays,
    agentNotificationRetentionDays: settings.agentNotificationRetentionDays,
    agentFailureRetentionDays: settings.agentFailureRetentionDays,
    agentOptimizerWindowDays: settings.agentOptimizerWindowDays,
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Settings</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Organization-wide controls. Changes take effect within a minute and are recorded in the{' '}
        <Link
          href={`/${slug}/admin/audit`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          audit trail
        </Link>
        .
      </p>

      <SettingsForm slug={slug} initial={initial} />

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-950">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Elsewhere
        </h2>
        <ul className="space-y-1 text-gray-600 dark:text-gray-400">
          <li>
            Connector on/off switches and scope ceilings —{' '}
            <Link
              href={`/${slug}/admin/connectors`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Connector setup
            </Link>
          </li>
          <li>
            Redaction detectors and record-number formats —{' '}
            <Link
              href={`/${slug}/admin/redaction`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Sensitive data
            </Link>
          </li>
          <li>
            Agent run history retention —{' '}
            <Link
              href={`/${slug}/admin/agents`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Agent oversight
            </Link>
          </li>
        </ul>
      </section>

      <section className="mt-4 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-950">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Identity
        </h2>
        <p className="text-gray-600 dark:text-gray-400">
          Sign-in (OIDC):{' '}
          {oidc ? (
            <>
              <span className="font-medium text-green-700 dark:text-green-400">configured</span>
              <span className="ml-2 break-all font-mono text-xs text-gray-500">{oidc.issuer}</span>
            </>
          ) : (
            <span className="font-medium text-amber-700 dark:text-amber-400">not configured</span>
          )}
        </p>
        <p className="mt-1 text-gray-600 dark:text-gray-400">
          Organization slug: <code className="text-xs">{slug}</code>
        </p>
      </section>
    </div>
  );
}
