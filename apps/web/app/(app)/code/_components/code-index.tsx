'use client';

import Link from 'next/link';
import type { ProjectListItem } from '@/lib/chat/sidebar';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { DataFrame, DataTable, Pager, Th } from '@/components/data-table';
import {
  codeIndexHref,
  ownerLabel,
  type CodeIndexGroup,
  type CodeIndexQuery,
  type CodeIndexView,
} from './code-index.model';
import CodeSearch from './code-search';

export default function CodeIndex({ projects, query, view, enabled, canCreate, accessNotice }: {
  /** Every project the person can open (what the search and pages slice). */
  projects: ProjectListItem[];
  query: CodeIndexQuery;
  view: CodeIndexView;
  /** The deployment runs code workspaces; without them nothing here can be made. */
  enabled: boolean;
  /** This person's Bitbucket or GitHub connection carries what a project runs on (lib/code/access.ts). */
  canCreate: boolean;
  /** When it does not: what to connect, said the Connectors page's way. */
  accessNotice: string | null;
}) {
  const newAnchor = useCoachAnchor('code-new');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Code</h1>
        {enabled && canCreate ? (
          <Link
            href={`/code/new`}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            {...newAnchor}
          >
            New code project
          </Link>
        ) : null}
      </header>
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          A code project is a repository from Bitbucket or GitHub, cloned into the sandbox, with the
          environment its commands need. Chats inside it can read and change the code, run the
          project’s own tests and builds, commit, and push a branch for a pull request — with Jira
          and your other connectors beside them.
        </p>
        {!enabled ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            Code workspaces are not enabled for this organization. An operator turns them on under
            Settings → Sandbox.
          </p>
        ) : !canCreate && accessNotice ? (
          <p
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {accessNotice}{' '}
            <Link href={`/connectors`} className="underline">
              Open Connectors
            </Link>
            . A code project clones, pushes and opens pull requests with your own access on the
            repository’s host.
          </p>
        ) : null}
        {projects.length > 0 ? <CodeSearch initialQ={query.q} /> : null}
        <ProjectTable
          title="Mine"
          label="Code projects"
          group={view.mine}
          showOwner={false}
          empty="You have no code projects yet."
          hrefFor={(page) => codeIndexHref({ ...query, page })}
        />
        <ProjectTable
          title="Shared with me"
          label="Shared code projects"
          group={view.shared}
          showOwner
          empty="Nothing has been shared with you."
          hrefFor={(sharedPage) => codeIndexHref({ ...query, sharedPage })}
        />
      </div>
    </div>
  );
}

/** One table of projects with its own pager: mine, or the ones shared with me (with their owner). */
function ProjectTable({ title, label, group, showOwner, empty, hrefFor }: {
  title: string;
  /** The frame's accessible name; the pager's is "<label> pages". */
  label: string;
  group: CodeIndexGroup;
  showOwner: boolean;
  /** What an empty table says when there is nothing at all (a search that finds nothing says so). */
  empty: string;
  /** The list's URL with this table on that page. */
  hrefFor: (page: number) => string;
}) {
  const { paging } = group;
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h2>
      <DataFrame
        label={label}
        stickyFooter={false}
        bodyHeight={showOwner ? SHARED_BODY : MINE_BODY}
        empty={
          group.empty ? (
            <p className="p-4 text-sm text-gray-500">
              {group.empty === 'no-match' ? 'No projects match your search.' : empty}
            </p>
          ) : undefined
        }
        table={
          <DataTable
            head={
              <>
                <Th className={showOwner ? 'w-[40%]' : 'w-[55%]'}>Project</Th>
                <Th>Repository</Th>
                {showOwner ? <Th className="w-[20%]">Owner</Th> : null}
              </>
            }
          >
            {paging.rows.map((project) => (
              <Row key={project.id} project={project} showOwner={showOwner} />
            ))}
          </DataTable>
        }
        cards={
          <>
            {paging.rows.map((project) => (
              <Card key={project.id} project={project} showOwner={showOwner} />
            ))}
          </>
        }
        footer={
          paging.range ? (
            <Pager
              label={`${label} pages`}
              range={`Projects ${paging.range}`}
              previousHref={paging.hasPrevious ? hrefFor(paging.page - 1) : null}
              nextHref={paging.hasNext ? hrefFor(paging.page + 1) : null}
            />
          ) : null
        }
      />
    </section>
  );
}

/**
 * Every row and card is a fixed height — long names and descriptions
 * truncate — so a table's visible height is a whole number of them: five
 * rows of mine, three shared with me (a page is ten; the rest scrolls
 * inside, the headings and the pager staying put). From `sm` up the body is
 * the table's heading (about 2.1rem) and its rows (3.5rem each); below it,
 * the cards (5.75rem each, 0.5rem apart and around).
 */
const ROW_HEIGHT = 'h-14';
const CARD_HEIGHT = 'h-[5.75rem]';
const MINE_BODY = 'h-[31.75rem] sm:h-[19.6rem]';
const SHARED_BODY = 'h-[19.25rem] sm:h-[12.6rem]';

/** One project as a table row: from the `sm` breakpoint up. */
function Row({ project, showOwner }: { project: ProjectListItem; showOwner: boolean }) {
  return (
    <tr className={`${ROW_HEIGHT} border-t border-gray-100 dark:border-gray-800`}>
      <td className="px-3 align-middle">
        <Link
          href={`/code/${project.id}`}
          title={project.name}
          className="block truncate font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-400"
        >
          {project.name}
        </Link>
        {project.description ? (
          <span
            title={project.description}
            className="block truncate text-xs text-gray-600 dark:text-gray-400"
          >
            {project.description}
          </span>
        ) : null}
      </td>
      <td className="truncate px-3 align-middle font-mono text-xs text-gray-600 dark:text-gray-400">
        {project.repoFullName ?? '—'}
      </td>
      {showOwner ? (
        <td className="truncate px-3 align-middle text-gray-600 dark:text-gray-400">
          {ownerLabel(project)}
        </td>
      ) : null}
    </tr>
  );
}

/** One project as a card, on a phone: the whole card is the link. */
function Card({ project, showOwner }: { project: ProjectListItem; showOwner: boolean }) {
  return (
    <li className={CARD_HEIGHT}>
      <Link
        href={`/code/${project.id}`}
        title={project.name}
        className="flex h-full flex-col justify-center gap-0.5 rounded-lg border border-gray-200 px-3 hover:border-blue-400 dark:border-gray-800"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-gray-900 dark:text-gray-100">
            {project.name}
          </span>
          {showOwner ? (
            <span className="ml-auto shrink-0 text-xs text-gray-500 dark:text-gray-400">
              {ownerLabel(project)}
            </span>
          ) : null}
        </span>
        <span className="truncate font-mono text-xs text-gray-500">
          {project.repoFullName ?? ''}
        </span>
        {project.description ? (
          <span className="truncate text-xs text-gray-600 dark:text-gray-400">
            {project.description}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
