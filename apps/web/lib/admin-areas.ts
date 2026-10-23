/**
 * The admin console's areas, by section: the Organization page lists them,
 * and the top-bar search finds them by name. One list, so the two cannot
 * drift apart.
 */

export interface AdminArea {
  href: string;
  label: string;
  detail: string;
}

export interface AdminSection {
  label: string;
  areas: AdminArea[];
}

/**
 * The Organization page: the admin console's front door, and the only
 * place the console's areas are listed — the app menu does not carry
 * them. A signed-in user without the operator role is told so rather
 * than being offered a sign-in that would change nothing; a signed-out
 * visitor is sent into the tenant's OIDC flow and comes back here (the
 * layout does this on a fresh load; this page does it for a session that
 * expired between two client-side navigations).
 */
export function adminSections(): AdminSection[] {
  const admin = `/admin`;
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
          href: `${admin}/mirth`,
          label: 'Mirth Connect',
          detail:
            'Register the Mirth Connect servers (dev, test, prod…) people can connect with their own accounts.',
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
        {
          href: `${admin}/storage`,
          label: 'Storage',
          detail: 'Where chat uploads and the files the assistant produces are kept.',
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
        {
          href: `${admin}/project-templates`,
          label: 'Project templates',
          detail: 'The starting instructions offered when someone creates a code project.',
        },
        {
          href: `${admin}/pipeline-templates`,
          label: 'Pipeline templates',
          detail:
            'The starting pipeline files offered on a code project’s Pipelines page when its repository has none.',
        },
        {
          href: `${admin}/code-services`,
          label: 'Code services',
          detail:
            'The container images a code project may start beside its checkout — your own registry, or the public ones by name.',
        },
      ],
    },
    {
      label: 'Usage',
      areas: [
        {
          href: `${admin}/usage`,
          label: 'Organization usage',
          detail:
            'Token spend by surface and by model; who is using it, and which agents do the most work per token. Pick a person to see their usage, groups and agents.',
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
        // The Email sanitizer page (`${admin}/email-sanitizer`) is deliberately
        // unlinked: it existed to clean mail on its way into the knowledge
        // index, and mail is no longer indexed (it is personal — read live
        // through each person's own grant). The route and its API still
        // exist pending their removal; nothing should lead a person there.
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
          href: `${admin}/access`,
          label: 'Access',
          detail:
            'Who is connected to what — every person and the connectors they hold, with disconnect.',
        },
        {
          href: `${admin}/audit`,
          label: 'Audit',
          detail: 'Who changed what in the console.',
        },
        {
          href: `${admin}/tutorials`,
          label: 'Tutorials',
          detail: 'Who has taken the guided tours, who finished them, and who skipped.',
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
