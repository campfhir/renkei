import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';

interface AdminArea {
  href: string;
  label: string;
  detail: string;
}

interface AdminSection {
  label: string;
  areas: AdminArea[];
}

/**
 * The Organization page: the admin console's front door, and the only
 * place the console's areas are listed — the app menu does not carry
 * them. A signed-in user without the operator role is told so rather
 * than being offered a sign-in that would change nothing; a signed-out
 * visitor is sent into the tenant's OIDC flow and comes back here.
 */
function adminSections(slug: string): AdminSection[] {
  const admin = `/${slug}/admin`;
  return [
    {
      label: 'Connections',
      areas: [
        {
          href: `${admin}/connectors`,
          label: 'Connector setup',
          detail: 'Enable connectors and hold their app registrations and credentials.',
        },
        {
          href: `${admin}/file-shares`,
          label: 'File shares',
          detail: 'Register the network shares people can connect with their own credentials.',
        },
        {
          href: `${admin}/sites`,
          label: 'Sites',
          detail: 'The SharePoint sites the organization indexes and watches.',
        },
        {
          href: `${admin}/llm-models`,
          label: 'Models',
          detail: 'The language models agents and the chat run on, and the default.',
        },
      ],
    },
    {
      label: 'Agents',
      areas: [
        {
          href: `${admin}/agents`,
          label: 'Agent oversight',
          detail: 'Every agent in the organization, its runs, and the ones that need a hand.',
        },
        {
          href: `${admin}/calendars`,
          label: 'Holiday calendars',
          detail: 'The days schedules skip.',
        },
      ],
    },
    {
      label: 'Data and policy',
      areas: [
        {
          href: `${admin}/redaction`,
          label: 'Sensitive data',
          detail: 'What is masked before it reaches a model, and how.',
        },
        {
          href: `${admin}/email-sanitizer`,
          label: 'Email sanitizer',
          detail: 'How mail is cleaned before it is indexed.',
        },
        {
          href: `${admin}/settings`,
          label: 'Settings',
          detail: 'Read-only mode, limits, retention windows and the other org-wide policy.',
        },
      ],
    },
    {
      label: 'People and records',
      areas: [
        {
          href: `${admin}/people`,
          label: 'People',
          detail: 'Everyone who has signed in, their roles and their connections.',
        },
        {
          href: `${admin}/audit`,
          label: 'Audit',
          detail: 'Who changed what in the console.',
        },
        {
          href: `${admin}/events`,
          label: 'Events',
          detail: 'The inbound event stream and its processing.',
        },
      ],
    },
  ];
}

export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();

  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (access) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-xl font-bold">Organization</h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          Everything an operator configures for {slug}. Activity for the whole organization is on
          the shared Activity page.
        </p>
        {adminSections(slug).map((section) => (
          <section key={section.label} className="mb-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {section.label}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {section.areas.map((area) => (
                <li key={area.href}>
                  <Link
                    href={area.href}
                    className="block h-full rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-300 hover:bg-blue-50/40 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-blue-800 dark:hover:bg-blue-950/20"
                  >
                    <p className="text-sm font-semibold">{area.label}</p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{area.detail}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  const session = await getSessionFromCookies(tenantRef.id);
  if (session) {
    return (
      <div className="mx-auto max-w-lg">
        <h2 className="mb-2 text-lg font-semibold">Operator access required</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          You are signed in, but your account does not carry the operator role for {slug}. Roles
          come from your identity provider&apos;s claim mapping — an existing operator can check it
          under Settings.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-2 text-lg font-semibold">Sign in required</h2>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        You need to be signed in to access the admin console for {slug}.
      </p>
      <a
        href={signInUrl(tenantRef.id, `/${slug}/admin`)}
        className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Sign in with your organization
      </a>
    </div>
  );
}
