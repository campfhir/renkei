import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAgents } from '@/lib/agents/store';
import { Icon, ICONS } from '@/components/icons';
import CoachTarget from '@/components/coach-marks/anchor';
import { PreferencesSectionBody } from '../section-body';

/**
 * Preferences › Agents: each agent of yours, and how many of its actions
 * run without asking you. The actions themselves are set on the agent
 * ("Runs without asking" in its editor): an agent is its own kind of
 * session, so what it may do unasked is its own, not a list shared by all
 * of them. Tools the organization locks always wait.
 */
export default async function AgentsPreferencesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/agents`));
  const [agents, org] = await Promise.all([
    listAgents(session.subject).catch(() => []),
    getOrgSettings(),
  ]);
  const policy = org.ok ? org.val.agentActStepsRequireApproval : 'externally_triggered';
  const locked = new Set(org.ok ? org.val.lockedHighRiskTools : []);
  return (
    <PreferencesSectionBody
      title="Agents"
      description="Each agent proposes its changes; the actions you let it run without asking skip the wait. Set them on the agent."
    >
      {policy !== 'off' ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
          {policy === 'all'
            ? 'Your organization has a person accept every agent’s actions, whatever an agent is allowed.'
            : 'Your organization also makes every run started by an event or a webhook wait for you.'}{' '}
          Tools it locks as high risk always wait.
        </p>
      ) : null}
      <CoachTarget name="prefs-high-risk">
        <section
          aria-labelledby="agents-allowed-heading"
          className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
        >
          <h3 id="agents-allowed-heading" className="px-4 pt-4 pb-2 font-semibold">
            Runs without asking
          </h3>
          {agents.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-gray-600 dark:text-gray-400">
              You have no agents yet.{' '}
              <Link href="/agents/new" className="text-blue-600 hover:underline dark:text-blue-400">
                Make one
              </Link>
              .
            </p>
          ) : (
            <ul className="border-t border-gray-200 dark:border-gray-800">
              {agents.map((agent) => {
                const unasked = agent.allowedActions.filter((tool) => !locked.has(tool));
                return (
                  <li
                    key={agent.id}
                    className="border-b border-gray-100 last:border-b-0 dark:border-gray-900"
                  >
                    <Link
                      href={`/agents/${agent.id}/edit`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <Icon path={ICONS.agent} className="h-4 w-4 shrink-0 text-gray-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{agent.name}</span>
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {unasked.length === 0 ? 'Every change waits for you' : unasked.join(', ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                        {unasked.length} unasked
                      </span>
                      <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </CoachTarget>
    </PreferencesSectionBody>
  );
}
