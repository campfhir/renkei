/**
 * The admin console's areas, by section: the Organization page lists them,
 * and the top-bar search finds them by name. One list, so the two cannot
 * drift apart.
 */

/** The icon an area shows in the console's sidebar: names in components/icons.tsx's ICONS. */
export type AdminAreaIcon =
  | 'plug'
  | 'folder'
  | 'loop'
  | 'pages'
  | 'sparkles'
  | 'archive'
  | 'package'
  | 'agent'
  | 'clock'
  | 'fileText'
  | 'layers'
  | 'puzzle'
  | 'deploy'
  | 'chart'
  | 'chip'
  | 'shield'
  | 'sliders'
  | 'lock'
  | 'history'
  | 'book'
  | 'activity';

export interface AdminArea {
  href: string;
  label: string;
  detail: string;
  icon: AdminAreaIcon;
  /**
   * Pages outside `href` that belong to this area and are reached from it,
   * so the sidebar keeps the area marked while one is open.
   */
  under?: string[];
}

export interface AdminSection {
  label: string;
  areas: AdminArea[];
}

/**
 * The console's areas in the order the sidebar and the Organization page
 * show them. The app menu does not carry them: it has the one
 * Organization link.
 */
export function adminSections(): AdminSection[] {
  const admin = `/admin`;
  return [
    {
      label: 'Connections',
      areas: [
        {
          href: `${admin}/connectors`,
          icon: 'plug',
          under: [`${admin}/mcp`, `${admin}/admanager`],
          label: 'Connector setup',
          detail: 'Enable connectors and hold their app registrations and credentials.',
        },
        {
          href: `${admin}/file-shares`,
          icon: 'folder',
          label: 'File shares',
          detail: 'Register the network shares people can connect with their own credentials.',
        },
        {
          href: `${admin}/mirth`,
          icon: 'loop',
          label: 'Mirth Connect',
          detail:
            'Register the Mirth Connect servers (dev, test, prod…) people can connect with their own accounts.',
        },
        {
          href: `${admin}/sites`,
          icon: 'pages',
          label: 'Sites',
          detail: 'The SharePoint sites the organization indexes and watches.',
        },
        {
          href: `${admin}/llm-models`,
          icon: 'sparkles',
          label: 'Models',
          detail: 'The language models agents and the chat run on, and the default.',
        },
        {
          href: `${admin}/storage`,
          icon: 'archive',
          label: 'Storage',
          detail: 'Where chat uploads and the files the assistant produces are kept.',
        },
        {
          href: `${admin}/sandboxes`,
          icon: 'package',
          label: 'Sandboxes',
          detail:
            'Where each person’s, agent’s and project’s sandbox is made, and what it starts with.',
        },
      ],
    },
    {
      label: 'Agents',
      areas: [
        {
          href: `${admin}/agents`,
          icon: 'agent',
          label: 'Agent oversight',
          detail: 'Every agent in the organization, its runs, and the ones that need a hand.',
        },
        {
          href: `${admin}/calendars`,
          icon: 'clock',
          label: 'Holiday calendars',
          detail: 'The days schedules skip.',
        },
      ],
    },
    {
      label: 'Code projects',
      areas: [
        {
          href: `${admin}/project-templates`,
          icon: 'fileText',
          label: 'Project templates',
          detail: 'The starting instructions offered when someone creates a code project.',
        },
        {
          href: `${admin}/code-services`,
          icon: 'layers',
          label: 'Code services',
          detail:
            'The container images a code project may start beside its checkout — your own registry, or the public ones by name.',
        },
        {
          href: `${admin}/ci-blocks`,
          icon: 'puzzle',
          label: 'Building blocks',
          detail:
            'The pipeline steps code projects build from — written once, for Bitbucket Pipelines and GitHub Actions.',
        },
        {
          href: `${admin}/ci-targets`,
          icon: 'deploy',
          label: 'Targets',
          detail:
            'Where deploy blocks run: your self-hosted runners, read from Bitbucket and GitHub with a service account.',
        },
      ],
    },
    {
      label: 'Usage',
      areas: [
        {
          href: `${admin}/usage`,
          icon: 'chart',
          label: 'Organization usage',
          detail:
            'Token spend by surface and by model; who is using it, and which agents do the most work per token. Pick a person to see their usage, groups and agents.',
        },
        {
          href: `${admin}/token-limits`,
          icon: 'chip',
          label: 'Token limits',
          detail:
            'How many tokens one person may spend in a week and a month, their agents included; limits on single models; who is unlimited, and boosts.',
        },
      ],
    },
    {
      label: 'Data and policy',
      areas: [
        {
          href: `${admin}/redaction`,
          icon: 'shield',
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
          icon: 'sliders',
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
          icon: 'lock',
          under: [`${admin}/grants`],
          label: 'Access',
          detail:
            'Who is connected to what — every person and the connectors they hold, with disconnect.',
        },
        {
          href: `${admin}/audit`,
          icon: 'history',
          label: 'Audit',
          detail: 'Who changed what in the console.',
        },
        {
          href: `${admin}/tutorials`,
          icon: 'book',
          label: 'Tutorials',
          detail: 'Who has taken the guided tours, who finished them, and who skipped.',
        },
        {
          href: `${admin}/events`,
          icon: 'activity',
          label: 'Events',
          detail: 'The inbound event stream and its processing.',
        },
      ],
    },
  ];
}
