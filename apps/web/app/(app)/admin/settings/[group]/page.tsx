import React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { listSizeRequests } from '@/lib/code/size-requests';
import { observedIdpGroups } from '@/lib/identity';
import { getTenantOidcSummary } from '@/lib/tenant-operations';
import { listHighRiskToolGroups } from '@/lib/chat/permission-catalog';
import CoachTarget from '@/components/coach-marks/anchor';
import HighRiskForm from '../../../preferences/high-risk-form';
import { SETTINGS_HREF, settingsGroup } from '../../admin-nav.model';
import { editableSettings } from '../editable-settings';
import IdentityForm from '../identity-form';
import { SettingsForm } from '../settings-form';
import { SizeRequests } from '../size-requests';

/**
 * One group of Settings: the parts of the form the group holds, saved
 * together, and under them whatever else belongs with it and saves on
 * its own — the locked tools under Safety, sign-in under General, the
 * checkout size requests under Sandbox & code. Each page reads only what
 * it shows.
 */
export default async function SettingsGroupPage({
  params,
}: {
  params: Promise<{ group: string }>;
}): Promise<React.ReactNode> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    redirect(`/admin`);
  }
  const group = settingsGroup((await params).group);
  if (!group) notFound();

  const settingsResult = await getOrgSettings();
  if (!settingsResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">Could not read org settings.</p>
      </div>
    );
  }
  const settings = settingsResult.val;

  return (
    <div className="max-w-3xl">
      <p className="mb-1 hidden text-sm text-gray-500 lg:block dark:text-gray-400">
        <Link href={SETTINGS_HREF} className="hover:underline">
          Settings
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-bold">{group.label}</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {group.blurb}. Changes take effect within a minute and are recorded in the{' '}
        <Link href={`/admin/audit`} className="text-blue-600 hover:underline dark:text-blue-400">
          audit trail
        </Link>
        .
      </p>

      <SettingsForm initial={editableSettings(settings)} parts={group.parts} />

      {group.id === 'safety' ? (
        <LockedTools
          subject={access.subject}
          roles={access.roles}
          locked={settings.lockedHighRiskTools}
        />
      ) : null}
      {group.id === 'sandbox' ? <SizeRequests requests={await listSizeRequests()} /> : null}
      {group.id === 'general' ? <Identity /> : null}
    </div>
  );
}

async function LockedTools({
  subject,
  roles,
  locked,
}: {
  subject: string;
  roles: string[];
  locked: string[];
}): Promise<React.ReactNode> {
  // Every act tool this operator can see: the locked list names tools
  // across connectors, and one locked elsewhere is still said below it.
  const toolGroups = await listHighRiskToolGroups(subject, roles, 'org').catch(() => []);
  return (
    <div id="locked-high-risk-tools" className="mt-6 scroll-mt-20">
      <HighRiskForm kind="org" groups={toolGroups} locked={locked} />
    </div>
  );
}

async function Identity(): Promise<React.ReactNode> {
  const [oidcResult, observedGroups] = await Promise.all([
    getTenantOidcSummary(),
    observedIdpGroups('', 10_000),
  ]);
  const oidc = oidcResult.ok ? oidcResult.val : null;
  return (
    <CoachTarget
      as="section"
      name="admin-settings-identity"
      className="mt-4 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-950"
    >
      <h2
        id="settings-identity"
        className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        Identity
      </h2>
      {oidcResult.ok ? (
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
      ) : (
        <p className="text-gray-600 dark:text-gray-400">Could not read the sign-in settings.</p>
      )}
      {oidc && (
        <IdentityForm
          initial={{
            roleClaim: oidc.roleClaim ?? '',
            operatorIdpValue: oidc.operatorIdpValue ?? '',
            userIdpValue: oidc.userIdpValue ?? '',
            groupsClaim: oidc.groupsClaim ?? '',
          }}
          observedGroups={observedGroups.length}
        />
      )}
    </CoachTarget>
  );
}
