import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { viewGate } from '@/lib/jira-admin/apply';
import { listSpaceTemplates } from '@/lib/jira-admin/space-templates';
import { SCHEME_KEYS, SCHEME_LABELS } from '@/lib/jira-admin/space-config';
import LocalTime from '@/components/local-time';

/**
 * The organization's Jira space templates (migration 124), read-only:
 * what each one sets up, so an admin can see what "a space like our
 * standard" would get before asking for one. Saving, deleting and building
 * from a template happen in chat; building from one is proposed for review
 * like any other change.
 */
export default async function JiraAdminTemplatesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/jira-admin/templates`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const gate = await viewGate(dbResult.val, tenant.id, session.subject);
  const templates = gate.ok ? await listSpaceTemplates(dbResult.val, tenant.id) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-bold">Space templates</h1>
        <Link
          href={`/${slug}/jira-admin/changes`}
          className="shrink-0 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Proposed changes
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        How your organization&apos;s Jira spaces are set up, saved from spaces configured the way
        you want. Ask in chat to save a space as a template, or to create a new space from one — the
        new space is proposed for your review, like any other change, and it runs on the same
        schemes as the template rather than copies of them.
      </p>

      {!gate.ok ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {gate.reason}
        </p>
      ) : templates.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          No templates yet. Ask in chat — for example, “save OPS as a template called Operations
          team” — and it shows up here.
        </p>
      ) : (
        <ul className="space-y-3">
          {templates.map((template) => {
            const roles = template.document.roles.filter((role) => role.groups.length > 0);
            return (
              <li
                key={template.id}
                data-testid="space-template"
                className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
              >
                <p className="font-medium break-words">{template.name}</p>
                {template.description && (
                  <p className="break-words text-gray-700 dark:text-gray-300">
                    {template.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {template.document.projectTypeKey} space
                  {template.sourceSpaceKey ? `, saved from ${template.sourceSpaceKey}` : ''}
                  {template.siteUrl ? ` on ${template.siteUrl}` : ''} · updated{' '}
                  <LocalTime at={template.updatedAt} format="date" />
                </p>
                <ul className="mt-2 space-y-0.5 text-gray-600 dark:text-gray-400">
                  {SCHEME_KEYS.map((key) => {
                    const scheme = template.document.schemes[key];
                    const label = SCHEME_LABELS[key];
                    return (
                      <li key={key} className="break-words">
                        {label.charAt(0).toUpperCase()}
                        {label.slice(1)}:{' '}
                        {scheme
                          ? `“${scheme.name}”`
                          : key === 'fieldConfigurationScheme'
                            ? 'the system default'
                            : 'none'}
                      </li>
                    );
                  })}
                  <li className="break-words">
                    Roles:{' '}
                    {roles.length === 0
                      ? 'no groups'
                      : roles
                          .map(
                            (role) =>
                              `${role.roleName} — ${role.groups.map((group) => group.name).join(', ')}`
                          )
                          .join('; ')}
                  </li>
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
