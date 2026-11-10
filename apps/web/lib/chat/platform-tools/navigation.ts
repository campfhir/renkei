/**
 * renkei_link — where things are in the app, as links the person can
 * follow: the pages of the menu, a setting or connector down to the element
 * that holds it (lib/app-places.ts, the top-bar search's own index), and the
 * person's own projects, code projects and prompt libraries by name.
 *
 * Every link is absolute, built on the address the person reached the app
 * at (shared.ts's linkTo): the app stands behind a proxy, and a model left
 * to guess a host would invent one. The organization's pages are listed
 * for operators only, the same rule the search applies.
 */

import { matchPlaceEntries } from '@/lib/app-places';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from '../local-tools';
import { loadChatSidebar } from '../sidebar';
import { listAccessibleLibraries } from '../prompts';
import { isOperator, markdownLink } from './shared';

export const LINK_TOOL = 'renkei_link';

export interface AppPage {
  title: string;
  href: string;
  /** What the page is for, in a line the model can repeat. */
  about: string;
  keywords: string;
  operatorOnly?: boolean;
}

/** The pages of the menu (app/(app)/nav.tsx) and the doors beside them. */
export const APP_PAGES: readonly AppPage[] = [
  {
    title: 'Home',
    href: '/',
    about: 'What needs attention: approvals, questions, recent runs.',
    keywords: 'dashboard start feed inbox',
  },
  {
    title: 'Agents',
    href: '/agents',
    about: 'The agents this person owns or can use.',
    keywords: 'automation runs schedule',
  },
  {
    title: 'Knowledge',
    href: '/knowledge',
    about: 'What the organization has indexed, and its sources.',
    keywords: 'search index sources documents',
  },
  {
    title: 'Artifacts',
    href: '/chat/artifacts',
    about: 'Files uploaded to chats and files chats made.',
    keywords: 'files uploads documents generated',
  },
  {
    title: 'Files',
    href: '/files',
    about: 'The file shares this person can browse.',
    keywords: 'shares folders network drive',
  },
  {
    title: 'Changes',
    href: '/changes',
    about: 'Change requests waiting for approval.',
    keywords: 'approvals change requests review',
    operatorOnly: true,
  },
  {
    title: 'Chat',
    href: '/chat',
    about: 'Every chat this person can open.',
    keywords: 'chats conversations history',
  },
  {
    title: 'New chat',
    href: '/chat/new',
    about: 'Start a new chat.',
    keywords: 'start conversation',
  },
  {
    title: 'Projects',
    href: '/chat/projects',
    about: 'Chat projects: shared instructions, memory and files.',
    keywords: 'chat projects workspace',
  },
  {
    title: 'Code',
    href: '/code',
    about: 'Code projects: a repository to work in.',
    keywords: 'code projects repository repositories git',
  },
  {
    title: 'New code project',
    href: '/code/new',
    about: 'Make a code project on a Bitbucket or GitHub repository.',
    keywords: 'create repository clone',
  },
  {
    title: 'Prompt libraries',
    href: '/chat/prompts',
    about: 'Reusable prompts, kept in libraries that can be shared.',
    keywords: 'prompts templates library',
  },
  {
    title: 'Memory',
    href: '/chat/memory',
    about: 'What chats remember about this person.',
    keywords: 'memories remember notes',
  },
  {
    title: 'Notifications',
    href: '/notifications',
    about: 'Everything this person was notified about.',
    keywords: 'alerts unread',
  },
  {
    title: 'Preferences',
    href: '/preferences',
    about: 'Appearance, notifications, voice, default tools and tool permissions.',
    keywords: 'settings options theme',
  },
  {
    title: 'Connectors',
    href: '/connectors',
    about: 'Connect or disconnect the systems tools act in.',
    keywords: 'connections integrations oauth sign in',
  },
  {
    title: 'Tutorials',
    href: '/tutorials',
    about: 'Replay a guided tour.',
    keywords: 'tours help guide walkthrough',
  },
  {
    title: 'Batch jobs',
    href: '/batch-jobs',
    about: 'Batch jobs and their schedules.',
    keywords: 'bulk schedule jobs',
  },
  {
    title: 'Tools',
    href: '/usage',
    about: 'Tool calls: which tools are used, how often and how they fare.',
    keywords: 'tool usage calls errors latency',
  },
  {
    title: 'My usage',
    href: '/utilization',
    about: "This person's own tokens, runs and tool calls.",
    keywords: 'usage tokens spend utilization statistics',
  },
  {
    title: 'Activity',
    href: '/logs',
    about: 'The activity log.',
    keywords: 'logs audit history events',
  },
  {
    title: 'Organization',
    href: '/admin',
    about: 'The organization console.',
    keywords: 'admin administration operators',
    operatorOnly: true,
  },
  {
    title: 'Organization usage',
    href: '/admin/usage',
    about: "The whole organization's tokens, runs and tool calls.",
    keywords: 'admin usage tokens spend people statistics',
    operatorOnly: true,
  },
  {
    title: 'Models',
    href: '/admin/llm-models',
    about: 'The models the organization offers.',
    keywords: 'llm models roster providers',
    operatorOnly: true,
  },
  {
    title: 'About',
    href: '/about',
    about: 'Version and what changed.',
    keywords: 'version changelog release notes',
  },
];

const MAX_LINKS = 10;

interface Destination {
  label: string;
  href: string;
  detail: string;
  /** What a query is matched against, lower-cased. */
  haystack: string;
  title: string;
}

function pageDestinations(operator: boolean): Destination[] {
  return APP_PAGES.filter((page) => operator || page.operatorOnly !== true).map((page) => ({
    label: page.title,
    href: page.href,
    detail: page.about,
    title: page.title.toLowerCase(),
    haystack: `${page.title} ${page.about} ${page.keywords}`.toLowerCase(),
  }));
}

/** The person's own projects, code projects and prompt libraries, by name. */
async function ownDestinations(subject: string): Promise<Destination[]> {
  const [sidebar, libraries] = await Promise.all([
    loadChatSidebar(subject).catch(() => null),
    listAccessibleLibraries(subject).catch(() => []),
  ]);
  const named = (label: string, href: string, kind: string, extra = ''): Destination => ({
    label,
    href,
    detail: kind,
    title: label.toLowerCase(),
    haystack: `${label} ${kind} ${extra}`.toLowerCase(),
  });
  return [
    ...(sidebar?.projects ?? []).map((project) =>
      named(project.name, `/chat/projects/${project.id}`, 'Chat project')
    ),
    ...(sidebar?.code.projects ?? []).map((project) =>
      named(
        project.name,
        `/code/${project.id}`,
        `Code project${project.repoFullName ? ` on ${project.repoFullName}` : ''}`,
        'repository'
      )
    ),
    ...libraries.map(({ library }) =>
      named(library.name, `/chat/prompts/${library.id}`, 'Prompt library', 'prompts')
    ),
  ];
}

/**
 * The destinations every word of the query appears in: title matches
 * first, then the rest, pages before settings before the person's own
 * things within each.
 */
export function matchDestinations(query: string, candidates: Destination[]): Destination[] {
  const needle = query.trim().toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matched = candidates.filter((entry) =>
    terms.every((term) => entry.haystack.includes(term))
  );
  const titled = (entry: Destination) => entry.title.includes(needle);
  return [...matched.filter(titled), ...matched.filter((entry) => !titled(entry))];
}

function linesOf(context: LocalToolContext, destinations: Destination[]): string {
  return destinations
    .map((entry) => `- ${markdownLink(context, entry.label, entry.href)}: ${entry.detail}`)
    .join('\n');
}

export function navigationTools(): LocalTool[] {
  return [
    {
      readOnly: true,
      def: {
        name: LINK_TOOL,
        description:
          'Links to places in Renkei itself: a page (Preferences, Connectors, My usage, Code, Prompt libraries, …), a specific setting or connector card (e.g. "dark mode", "notifications", "github"), or one of this person\'s own projects, code projects or prompt libraries by name. Call it whenever a reply should point the person somewhere in the app — never write a Renkei address from memory, the host is only known here. Give `to` (a few words); omit it to list the main pages. Hand the links over as the Markdown links returned.',
        inputSchema: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description:
                'What the person wants to reach: a page, a setting, a connector, or the name of a project or prompt library. Omit to list the main pages.',
            },
          },
        },
      },
      async execute(input, context) {
        const operator = isOperator(context);
        const pages = pageDestinations(operator);
        const query = typeof input.to === 'string' ? input.to.trim() : '';
        if (!query) {
          return textResult(`The main pages of Renkei:\n${linesOf(context, pages)}`);
        }
        const places: Destination[] = matchPlaceEntries(query.toLowerCase(), operator).map(
          (place) => ({
            label: place.title,
            href: place.href,
            detail: place.where,
            title: place.title.toLowerCase(),
            haystack: '',
          })
        );
        const found = [
          ...matchDestinations(query, pages),
          ...places,
          ...matchDestinations(query, await ownDestinations(context.subject)),
        ];
        // A place can be reached two ways (a page and its own setting): once each.
        const seen = new Set<string>();
        const unique = found.filter((entry) =>
          seen.has(entry.href) ? false : (seen.add(entry.href), true)
        );
        if (unique.length === 0) {
          return errorResult(
            `Nothing in Renkei matched "${query}". Try fewer or different words, or call ${LINK_TOOL} with no input to list the main pages.`
          );
        }
        return textResult(
          `Found ${Math.min(unique.length, MAX_LINKS)} place(s) for "${query}":\n${linesOf(context, unique.slice(0, MAX_LINKS))}`
        );
      },
    },
  ];
}
