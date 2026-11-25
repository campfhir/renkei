import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getChatToolPermissionPrefs } from '@/lib/chat/permission-prefs';
import { listChatToolGroups } from '@/lib/chat/permission-catalog';
import { isChatSessionKind, type ChatSessionKind } from '@/lib/chat/permission-rules';
import { PreferencesSectionBody } from '../section-body';
import ToolPermissionsForm from '../tool-permissions-form';

const KINDS: { kind: ChatSessionKind; label: string; about: string }[] = [
  { kind: 'chat', label: 'Chats', about: 'Ordinary chats, outside any project.' },
  {
    kind: 'project',
    label: 'Chat projects',
    about: 'Chats in a chat project. The project can also allow or ask for its own chats.',
  },
  {
    kind: 'code',
    label: 'Code projects',
    about:
      'Chats in a code project. In Auto mode, what nothing decides runs unless you mark it high risk under Code projects.',
  },
];

/**
 * Preferences › Tool permissions: what a chat may do without asking, and
 * what it may never do — kept per kind of chat (an ordinary chat, a chat
 * project's, a code project's), picked by the tabs at the top.
 */
export default async function PermissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string | string[] }>;
}): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/permissions`));
  const asked = (await searchParams).kind;
  const kind: ChatSessionKind = isChatSessionKind(asked) ? asked : 'chat';
  const [toolPermissions, groups, org] = await Promise.all([
    getChatToolPermissionPrefs(session.subject, { fresh: true, kind }),
    // Reading tools too: they never ask, but they can be blocked.
    listChatToolGroups(session.subject, session.roles),
    getOrgSettings(),
  ]);
  const current = KINDS.find((entry) => entry.kind === kind) ?? KINDS[0];
  return (
    <PreferencesSectionBody
      title="Tool permissions"
      description="What a chat may do without asking, and what it may never do — for each kind of chat."
    >
      <nav
        aria-label="Kind of chat"
        className="flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-800 dark:bg-gray-900"
      >
        {KINDS.map((entry) => (
          <Link
            key={entry.kind}
            href={
              entry.kind === 'chat'
                ? '/preferences/permissions'
                : `/preferences/permissions?kind=${entry.kind}`
            }
            aria-current={entry.kind === kind ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm ${
              entry.kind === kind
                ? 'bg-white font-medium shadow-sm dark:bg-gray-950'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            }`}
          >
            {entry.label}
          </Link>
        ))}
      </nav>
      <p className="-mt-3 text-xs text-gray-500 dark:text-gray-400">{current.about}</p>
      <ToolPermissionsForm
        key={kind}
        kind={kind}
        groups={groups}
        initial={toolPermissions}
        locked={org.ok ? org.val.lockedHighRiskTools : []}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        A chat can still decide for itself from its Tools dialog: block a tool, make a reading one
        ask, or let one act without asking. Tools your organization locks always ask. What agents
        run without asking is set on each agent (
        <Link
          href="/preferences/agents"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Agents
        </Link>
        ).
      </p>
    </PreferencesSectionBody>
  );
}
