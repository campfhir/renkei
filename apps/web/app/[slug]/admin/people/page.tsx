import React from 'react';
import Link from 'next/link';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sql } from 'kysely';
import ConnectorIcon from '@/components/connector-icon';
import { grantProviderLabel } from '@/lib/provider-labels';
import RevokeGrantButton from './revoke-grant-button';

/**
 * Everyone in the org, and what the platform is FOR each of them: which
 * connectors they've linked (with the operator's disconnect right there)
 * and which agents they own. One card per person rather than a table —
 * connector and agent lists are ragged, and a card stacks cleanly on a
 * phone where the old table forced a sideways scroll.
 *
 * People are unioned from three sources, not read from one: the identity
 * spine (anyone who signed in), grant owners, and agent owners. Any one
 * alone under-counts — a grant can outlive its owner's last sign-in.
 */

/** provider_grants.provider → the icon the connector catalog uses. */
const PROVIDER_ICON_KEY: Record<string, string> = {
  atlassian: 'jira',
  'atlassian-jsm': 'jira',
  'atlassian-confluence': 'atlassian-confluence',
  microsoft: 'microsoft',
  webex: 'webex',
  zoom: 'zoom',
};

interface PersonRow {
  subject: string;
  name: string;
  email: string | null;
  lastActive: Date | null;
  grants: { provider: string; accountId: string; displayName: string | null; expired: boolean }[];
  agents: { id: string; name: string; enabled: boolean }[];
}

export default async function PeoplePage({
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
  const db = dbResult.val;

  const [identities, grants, agents, activity] = await Promise.all([
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email'])
      .where('tenant_id', '=', tenantRef.id)
      .execute(),
    db
      .selectFrom('provider_grants')
      .select(['subject', 'provider', 'provider_account_id', 'display_name', 'expires_at'])
      .where('tenant_id', '=', tenantRef.id)
      .orderBy('provider')
      .execute(),
    db
      .selectFrom('agents')
      .select(['id', 'name', 'enabled', 'owner_subject'])
      .where('tenant_id', '=', tenantRef.id)
      .orderBy('name')
      .execute(),
    db
      .selectFrom('sessions')
      .select(['subject', sql<Date>`max(last_used_at)`.as('last_used_at')])
      .where('tenant_id', '=', tenantRef.id)
      .groupBy('subject')
      .execute(),
  ]);

  const people = new Map<string, PersonRow>();
  const personFor = (subject: string): PersonRow => {
    let person = people.get(subject);
    if (!person) {
      person = { subject, name: subject, email: null, lastActive: null, grants: [], agents: [] };
      people.set(subject, person);
    }
    return person;
  };

  for (const identity of identities) {
    const person = personFor(identity.subject);
    person.name = identity.display_name || identity.email;
    person.email = identity.email;
  }
  for (const grant of grants) {
    if (!grant.subject) continue;
    const person = personFor(grant.subject);
    person.grants.push({
      provider: grant.provider,
      accountId: grant.provider_account_id,
      displayName: grant.display_name,
      expired: new Date(grant.expires_at) < new Date(),
    });
    // A grant's display name beats a bare subject when no identity exists.
    if (person.name === person.subject && grant.display_name) person.name = grant.display_name;
  }
  for (const agent of agents) {
    personFor(agent.owner_subject).agents.push({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
    });
  }
  for (const row of activity) {
    const person = people.get(row.subject);
    if (person) person.lastActive = row.last_used_at;
  }

  const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">People</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Everyone who has signed in, connected an account, or built an agent. Disconnecting a
        connector here cuts Renkei&apos;s access immediately — the person can reconnect any time.
      </p>

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Nobody yet — people appear when they first sign in.
        </div>
      ) : (
        <div className="space-y-4">
          {sorted.map((person) => (
            <div
              key={person.subject}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <span className="font-semibold">{person.name}</span>
                  {person.email && person.email !== person.name && (
                    <span className="ml-2 break-all text-sm text-gray-500">{person.email}</span>
                  )}
                </div>
                {person.lastActive && (
                  <span className="text-xs text-gray-500">
                    active {new Date(person.lastActive).toLocaleDateString()}
                  </span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {person.grants.length === 0 ? (
                  <span className="text-sm text-gray-400 dark:text-gray-600">
                    No connectors linked
                  </span>
                ) : (
                  person.grants.map((grant) => (
                    <span
                      key={`${grant.provider}:${grant.accountId}`}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                        grant.expired
                          ? 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400'
                          : 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-300'
                      }`}
                      title={grant.displayName ?? grant.accountId}
                    >
                      <ConnectorIcon
                        capabilityKey={PROVIDER_ICON_KEY[grant.provider] ?? grant.provider}
                        label={grantProviderLabel(grant.provider)}
                        size={14}
                      />
                      {grantProviderLabel(grant.provider)}
                      {grant.expired && <span title="Token expired; refresh due">⚠️</span>}
                      <RevokeGrantButton
                        slug={slug}
                        provider={grant.provider}
                        providerLabel={grantProviderLabel(grant.provider)}
                        accountId={grant.accountId}
                        displayName={person.name}
                      />
                    </span>
                  ))
                )}
              </div>

              {person.agents.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-gray-500">Agents</span>
                  {person.agents.map((agent) => (
                    <Link
                      key={agent.id}
                      href={`/${slug}/admin/agents`}
                      className={`hover:underline ${
                        agent.enabled
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-gray-400 line-through dark:text-gray-600'
                      }`}
                      title={agent.enabled ? 'Enabled' : 'Off'}
                    >
                      {agent.name}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
