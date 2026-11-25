import React from 'react';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { getHighRiskPrefs } from '@renkei/user-prefs';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listHighRiskToolGroups } from '@/lib/chat/permission-catalog';
import CoachTarget from '@/components/coach-marks/anchor';
import { PreferencesSectionBody } from '../section-body';
import HighRiskForm from '../high-risk-form';

/** Preferences › Agents: what still waits for you when an agent accepts its own actions. */
export default async function AgentsPreferencesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/agents`));
  const [prefs, groups, org] = await Promise.all([
    getHighRiskPrefs(session.subject, 'agents', { fresh: true }),
    listHighRiskToolGroups(session.subject, session.roles, 'agents'),
    getOrgSettings(),
  ]);
  const policy = org.ok ? org.val.agentActStepsRequireApproval : 'externally_triggered';
  return (
    <PreferencesSectionBody
      title="Agents"
      description="How your agents act when nobody is watching."
    >
      {policy !== 'off' ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
          {policy === 'all'
            ? 'Your organization has a person accept every agent’s actions, whatever is on this list.'
            : 'Your organization also makes every run started by an event or a webhook wait for you, whatever is on this list.'}
        </p>
      ) : null}
      <CoachTarget name="prefs-high-risk">
        <HighRiskForm
          kind="agents"
          groups={groups}
          locked={org.ok ? org.val.lockedHighRiskTools : []}
          initial={prefs}
        />
      </CoachTarget>
    </PreferencesSectionBody>
  );
}
