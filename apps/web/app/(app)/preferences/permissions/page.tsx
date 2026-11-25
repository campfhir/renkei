import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getChatToolPermissionPrefs } from '@/lib/chat/permission-prefs';
import { listChatToolGroups } from '@/lib/chat/permission-catalog';
import { PreferencesSectionBody } from '../section-body';
import ToolPermissionsForm from '../tool-permissions-form';

/** Preferences › Tool permissions: what a chat may do without asking, and what it may never do. */
export default async function PermissionsPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/permissions`));
  const [toolPermissions, groups, org] = await Promise.all([
    getChatToolPermissionPrefs(session.subject, { fresh: true }),
    // Reading tools too: they never ask, but they can be blocked.
    listChatToolGroups(session.subject, session.roles),
    getOrgSettings(),
  ]);
  return (
    <PreferencesSectionBody
      title="Tool permissions"
      description="What a chat may do without asking, and what it may never do."
    >
      <ToolPermissionsForm
        groups={groups}
        initial={toolPermissions}
        locked={org.ok ? org.val.lockedHighRiskTools : []}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Blocked tools stay blocked everywhere, Auto mode and agents included. What still asks when
        something runs on its own is under{' '}
        <Link
          href="/preferences/agents"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Agents
        </Link>{' '}
        and{' '}
        <Link href="/preferences/code" className="text-blue-600 hover:underline dark:text-blue-400">
          Code projects
        </Link>
        . A chat&rsquo;s own &ldquo;in this chat&rdquo; answers stay with that chat.
      </p>
    </PreferencesSectionBody>
  );
}
