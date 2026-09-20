import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sql } from 'kysely';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { grantProviderLabel } from '@/lib/provider-labels';
import ConnectorIcon from '@/components/connector-icon';
import LocalTime from '@/components/local-time';
import RevokeGrantButton from './revoke-grant-button';
import CoachTarget from '@/components/coach-marks/anchor';

/**
 * Access: who is connected to what — one table, a row per person and
 * connector they have linked, with the operator's disconnect right on the
 * row. Disconnecting cuts Renkei's access immediately; the person can
 * reconnect any time from their own Connectors page.
 *
 * People are unioned from the identity spine (anyone who signed in) and
 * grant owners, not read from one: a grant can outlive its owner's last
 * sign-in, and someone who signed in but linked nothing still belongs in
 * the answer to "who has access" — as a row that says so.
 */

/** provider_grants.provider → the icon the connector catalog uses. */
const PROVIDER_ICON_KEY: Record<string, string> = {
  atlassian: 'jira',
  'atlassian-jsm': 'jira',
  'atlassian-confluence': 'atlassian-confluence',
  'atlassian-bitbucket': 'atlassian-bitbucket',
  microsoft: 'microsoft',
  webex: 'webex',
  zoom: 'zoom',
  onbase: 'onbase',
  'onbase-admin': 'onbase-admin',
};

interface Person {
  subject: string;
  name: string;
  email: string | null;
  lastActive: Date | null;
}

interface GrantRow {
  provider: string;
  accountId: string;
  displayName: string | null;
  expiresAt: Date;
  expired: boolean;
}

export default async function AccessPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
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

  const [identities, grants, activity] = await Promise.all([
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email'])
      .where('tenant_id', '=', tenant.id)
      .execute(),
    db
      .selectFrom('provider_grants')
      .select(['subject', 'provider', 'provider_account_id', 'display_name', 'expires_at'])
      .where('tenant_id', '=', tenant.id)
      .orderBy('provider')
      .execute(),
    db
      .selectFrom('sessions')
      .select(['subject', sql<Date>`max(last_used_at)`.as('last_used_at')])
      .where('tenant_id', '=', tenant.id)
      .groupBy('subject')
      .execute(),
  ]);

  const people = new Map<string, Person>();
  const personFor = (subject: string): Person => {
    let person = people.get(subject);
    if (!person) {
      person = { subject, name: subject, email: null, lastActive: null };
      people.set(subject, person);
    }
    return person;
  };
  for (const identity of identities) {
    const person = personFor(identity.subject);
    person.name = identity.display_name || identity.email;
    person.email = identity.email;
  }
  const grantsBySubject = new Map<string, GrantRow[]>();
  const now = Date.now();
  for (const grant of grants) {
    if (!grant.subject) continue;
    const person = personFor(grant.subject);
    // A grant's display name beats a bare subject when no identity exists.
    if (person.name === person.subject && grant.display_name) person.name = grant.display_name;
    const expiresAt = new Date(grant.expires_at);
    const rows = grantsBySubject.get(grant.subject) ?? [];
    rows.push({
      provider: grant.provider,
      accountId: grant.provider_account_id,
      displayName: grant.display_name,
      expiresAt,
      expired: expiresAt.getTime() < now,
    });
    grantsBySubject.set(grant.subject, rows);
  }
  for (const row of activity) {
    const person = people.get(row.subject);
    if (person) person.lastActive = row.last_used_at;
  }

  const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const linked = grants.length;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Access</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Who is connected to what: everyone who has signed in or linked an account, and each
        connector they hold. Disconnecting cuts Renkei&apos;s access immediately — the person can
        reconnect any time. A person&apos;s usage, groups and agents are on{' '}
        <Link
          href={`/${slug}/admin/usage`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Organization usage
        </Link>
        .
      </p>

      <CoachTarget name="admin-access-table">
        {sorted.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
            Nobody yet — people appear when they first sign in.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {sorted.length} people, {linked} linked connectors
              </caption>
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 font-medium">Connector</th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium">Expires</th>
                  <th className="px-3 py-2 font-medium">Last active</th>
                  <th className="px-3 py-2 font-medium" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((person) => {
                  const rows = grantsBySubject.get(person.subject) ?? [];
                  const personCell = (
                    <td className="px-3 py-2 align-top" rowSpan={Math.max(1, rows.length)}>
                      <Link
                        href={`/${slug}/admin/usage?user=${encodeURIComponent(person.subject)}`}
                        className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {person.name}
                      </Link>
                      {person.email && person.email !== person.name && (
                        <span className="block break-all text-xs text-gray-500">
                          {person.email}
                        </span>
                      )}
                    </td>
                  );
                  const activeCell = (
                    <td
                      className="px-3 py-2 align-top text-xs text-gray-500"
                      rowSpan={Math.max(1, rows.length)}
                    >
                      {person.lastActive ? (
                        <LocalTime at={person.lastActive} format="date" />
                      ) : (
                        'never signed in'
                      )}
                    </td>
                  );
                  if (rows.length === 0) {
                    return (
                      <tr
                        key={person.subject}
                        className="border-t border-gray-200 dark:border-gray-800"
                      >
                        {personCell}
                        <td className="px-3 py-2 text-gray-400 dark:text-gray-600" colSpan={3}>
                          No connectors linked
                        </td>
                        {activeCell}
                        <td className="px-3 py-2" />
                      </tr>
                    );
                  }
                  return rows.map((grant, index) => (
                    <tr
                      key={`${person.subject}:${grant.provider}:${grant.accountId}`}
                      className={
                        index === 0
                          ? 'border-t border-gray-200 dark:border-gray-800'
                          : 'border-t border-gray-100 dark:border-gray-900'
                      }
                    >
                      {index === 0 && personCell}
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <ConnectorIcon
                            capabilityKey={PROVIDER_ICON_KEY[grant.provider] ?? grant.provider}
                            label={grantProviderLabel(grant.provider)}
                            size={16}
                          />
                          {grantProviderLabel(grant.provider)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                        {grant.displayName ?? grant.accountId}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {grant.expired ? (
                          <span
                            className="text-amber-700 dark:text-amber-400"
                            title="Token expired; refresh due"
                          >
                            ⚠️ expired
                          </span>
                        ) : (
                          <span className="text-gray-500">
                            <LocalTime at={grant.expiresAt} format="date" />
                          </span>
                        )}
                      </td>
                      {index === 0 && activeCell}
                      <td className="px-3 py-2 text-right">
                        <RevokeGrantButton
                          slug={slug}
                          provider={grant.provider}
                          providerLabel={grantProviderLabel(grant.provider)}
                          accountId={grant.accountId}
                          displayName={person.name}
                        />
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </CoachTarget>
    </div>
  );
}
