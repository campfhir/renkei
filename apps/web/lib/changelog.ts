/**
 * What changed in Renkei, newest first — the content behind About.
 *
 * ## Why this is TypeScript and not CHANGELOG.md
 *
 * A markdown file at the repo root reads better in a diff, and it was the
 * first thing tried. It does not survive deployment: the runtime image copies
 * `apps/` and `packages/` and a handful of named config files, so a root
 * CHANGELOG.md is simply absent in production and reading it would throw on
 * the one machine where it matters. Shipping it would mean a Dockerfile
 * change plus a markdown parser (there is no renderer in this app, and
 * hand-rolling one is a tar pit for the sake of two heading levels).
 *
 * As a module it ships with the bundle, needs no parser, and the compiler
 * catches a malformed entry. The cost is that it is edited as code.
 *
 * ## Writing entries
 *
 * For the people who USE Renkei, not the people who wrote it. Say what is
 * different now. If nobody outside this codebase would notice the change, it
 * does not get an entry — a changelog that lists refactors is one nobody
 * reads, and then the entries that matter are missed too.
 *
 * `date` is the day the work landed on `main`, ISO, or null for work that has
 * not shipped yet.
 */

export interface ChangelogEntry {
  /** What changed, in a few words. */
  title: string;
  /** One or two sentences. Say the behaviour, not the implementation. */
  detail: string;
  kind: 'added' | 'changed' | 'fixed';
}

export interface ChangelogRelease {
  /** ISO date, or null for unreleased work sitting on main. */
  date: string | null;
  /** Optional theme, when a group of entries share one. */
  heading?: string;
  entries: ChangelogEntry[];
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    date: null,
    heading: 'On the way',
    entries: [
      {
        kind: 'fixed',
        title: 'Agent failures name the step that stopped them',
        detail:
          'The failure line in Activity read `failed at step "{failedStep}"` — the placeholder itself, never a step name. It now names the step, and says so plainly on the rare occasion the step cannot be identified.',
      },
      {
        kind: 'fixed',
        title: 'Indexing says which documents it took in',
        detail:
          'SharePoint, OneDrive, Jira and Confluence sweeps reported a count and a location. They now name the documents, issues or pages — up to five, with a count of the rest.',
      },
      {
        kind: 'fixed',
        title: 'Malformed searches get an answer, not a Jira error',
        detail:
          "A JQL query with an unclosed bracket, or with ORDER BY inside one, came back as \"Expecting ')' but got 'ORDER'\" and a character offset. Renkei now names the problem and suggests the corrected query.",
      },
      {
        kind: 'changed',
        title: 'Connectors are laid out as a grid',
        detail:
          'Up to three across on a wide screen, with the MCP endpoint URL leading rather than buried beneath every card.',
      },
      {
        kind: 'changed',
        title: 'Back and Remove look the same everywhere',
        detail:
          'Going back is a chevron in the title on every page, and removing something is an icon-and-label button in the top right of the panel it belongs to.',
      },
      {
        kind: 'changed',
        title: 'Mail classification is no longer in the menu',
        detail:
          'The page still exists and still works — it is the only place to correct how your own mail was classified — but it needed no daily visit. The WebEx org-bot card is gone; the feature it described is retired.',
      },
    ],
  },
  {
    date: '2026-08-25',
    entries: [
      {
        kind: 'fixed',
        title: 'Preview cards work a second time',
        detail:
          'Cancelling a preview left every later preview of the same kind stuck showing the cancelled state, with no fields and no button.',
      },
      {
        kind: 'fixed',
        title: 'Preview cards shrink when they finish',
        detail:
          'An approved or cancelled card kept the height of the form it was no longer showing.',
      },
      {
        kind: 'added',
        title: 'A link to what was just made',
        detail:
          'Creating a ticket, event or message gives you a link straight to it from the card.',
      },
      {
        kind: 'added',
        title: 'Service Management tickets carry the portal link',
        detail: 'As well as the agent one, so a reporter gets a URL they can actually open.',
      },
      {
        kind: 'fixed',
        title: 'Mentions in Jira comments work',
        detail: 'Including the [~accountid:…] form, which used to post as literal text.',
      },
      {
        kind: 'changed',
        title: 'People can be named by email on any Jira field',
        detail:
          'Reporter, assignee or a custom user picker — Renkei resolves the account itself instead of reporting that it could not.',
      },
    ],
  },
  {
    date: '2026-08-24',
    heading: 'Email and calendar cleaning',
    entries: [
      {
        kind: 'added',
        title: 'Cleaning rules are yours to write',
        detail:
          'One mechanism — a TypeScript function per rule, edited in-product with autocomplete and type checking — replaces the built-in heuristics, the banner phrase list and the separate card.',
      },
      {
        kind: 'added',
        title: 'Rules reach calendar invites and tasks',
        detail: 'Not just mail, and each rule declares what it applies to.',
      },
      {
        kind: 'fixed',
        title: 'Wrapped links are unwrapped before indexing',
        detail:
          'Safelinks, Proofpoint, Barracuda and Mimecast gateways, including several layers of nesting.',
      },
      {
        kind: 'added',
        title: 'A starter library of rules',
        detail:
          'Quoted reply chains, signature blocks, legal footers, external-sender banners and conferencing boilerplate, ready to paste in.',
      },
    ],
  },
  {
    date: '2026-08-24',
    heading: 'Knowledge and activity',
    entries: [
      {
        kind: 'changed',
        title: 'Search understands key/value questions',
        detail: 'And shows which source each result came from.',
      },
      {
        kind: 'changed',
        title: 'Activity logs read as sentences',
        detail: 'And carry far less noise.',
      },
      {
        kind: 'changed',
        title: 'Dates in agent steps are edited as chips',
        detail: 'Rather than typed as text and hoped over.',
      },
    ],
  },
  {
    date: '2026-08-22',
    heading: 'Agent flow v3',
    entries: [
      {
        kind: 'added',
        title: 'Loops, groups and multi-way branches',
        detail:
          'Agents can repeat over a list, repeat until something is true, group related steps, and branch more than two ways — including a route for when a decision itself fails.',
      },
      {
        kind: 'changed',
        title: 'Deeper flows stay readable',
        detail:
          'Vertical routers instead of ever-widening columns, collapsible containers, and drill-in.',
      },
      {
        kind: 'added',
        title: 'Agents can be drafted from prose that describes triggers',
        detail: 'Say when it should run and the draft comes back with the trigger attached.',
      },
    ],
  },
];

/** The running build, for the About page's footer. */
export function buildLabel(packageVersion: string): string {
  const commit = process.env.GIT_COMMIT;
  return commit ? `${packageVersion}+${commit}` : packageVersion;
}
