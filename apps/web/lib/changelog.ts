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
    heading: 'Smarter schedules: time windows and recurrence',
    entries: [
      {
        kind: 'added',
        title: 'Schedules can limit hourly rules to specific times',
        detail:
          'A rule that fires every hour can now be constrained to active hours \u2014 "every hour, but only 8am to 6pm" \u2014 with support for split days (e.g. overnight windows as two entries). Schedules with an explicit time like "daily at 3pm" are unaffected. Works for both agent triggers and batch-job schedules.',
      },
      {
        kind: 'added',
        title: 'Batch jobs can run on a schedule',
        detail:
          'Set a batch job to repeat daily, weekly, monthly or on custom rules, the same way agents do. Schedules are managed from a dedicated page where you can edit, view run history and clone existing schedules.',
      },
    ],
  },
  {
    date: null,
    heading: 'Document processing with Mistral OCR',
    entries: [
      {
        kind: 'added',
        title: 'Extract text from images and PDFs',
        detail:
          'Batch jobs can now run the Mistral OCR pipeline to turn documents into searchable text. Admins configure the OCR service on the connectors page; the pipeline appears as a batch-job source and can be scheduled to run on a recurring basis.',
      },
    ],
  },
  {
    date: null,
    heading: 'Run a scheduled agent without waiting',
    entries: [
      {
        kind: 'added',
        title: 'Start a scheduled agent now, from chat',
        detail:
          'Your MCP client can bring a scheduled agent\u2019s next run forward with agent_run_now, instead of editing the schedule to make it fire. It only applies to an agent that is on and has a schedule switched on \u2014 anything else comes back saying which of the two is missing \u2014 and the schedule itself is untouched, so the next run still happens at its own time.',
      },
    ],
  },
  {
    date: null,
    heading: 'Agent knowledge you chose',
    entries: [
      {
        kind: 'fixed',
        title: 'Notes an agent files are no longer added to its own knowledge',
        detail:
          'A step that saved an organization note also, invisibly, added it to that agent’s permanent knowledge — so an agent doing its job slowly grew its own instructions with material nobody chose to put there. Saving a note is now just saving a note; agent knowledge is what you add on the agent’s Knowledge panel, or what it writes deliberately. Everything already there is left alone, and can be cleared below.',
      },
      {
        kind: 'changed',
        title: 'Runs get an index of the agent’s knowledge, not the ten newest notes',
        detail:
          'A run used to receive the ten most recently written notes, trimmed — so once an agent held more than ten, it silently saw whichever were newest rather than whichever were relevant, and had no way to know the rest existed. It now sees every note’s title up front (short notes in full) and reads the ones that look useful.',
      },
      {
        kind: 'added',
        title: 'Select and delete knowledge in bulk',
        detail:
          'Tick several notes and remove them together, or clear an agent’s knowledge entirely — the same two-click confirmation as clearing its memory. Long identifiers in a note now wrap inside their card instead of spilling out of it.',
      },
    ],
  },
  {
    date: null,
    heading: 'Editing an agent from outside the builder',
    entries: [
      {
        kind: 'fixed',
        title: 'The builder respects your organization’s step limit',
        detail:
          'An organization can raise how many steps an agent may hold, but the builder still refused to save past twenty — it was checking against the built-in default instead of your setting, so the Update button stayed disabled on an agent the server would have accepted.',
      },
      {
        kind: 'added',
        title: 'Change one step without resending the whole agent',
        detail:
          'Editing an agent over MCP meant sending its entire definition back, every untouched step copied out word for word — so slipping one new step between two others risked quietly rewriting something else. There is now a patch tool that inserts, replaces, removes or moves individual steps, positioned as “after this one” or “before that one”, and applies all of the changes or none of them.',
      },
    ],
  },
  {
    date: null,
    heading: 'OnBase stops spending licences it does not need',
    entries: [
      {
        kind: 'fixed',
        title: 'One OnBase session per person, not one per request',
        detail:
          'Every OnBase tool call opened a brand-new OnBase session and consumed a licence, so an agent reading ten documents held ten at once and released none for five minutes — on a busy day, enough to exhaust the pool and make perfectly good requests fail. Renkei now reuses your session across calls, and hands it back when it is finished.',
      },
    ],
  },
  {
    date: null,
    heading: 'Connected tools show up when you connect them',
    entries: [
      {
        kind: 'fixed',
        title: 'Newly connected tools no longer wait behind a stale list',
        detail:
          'Renkei told every client it would announce changes to its tool list, and then never announced any — so a client could reasonably hold the list it fetched on the day it connected, and a connector added afterwards stayed invisible to it. Renkei no longer makes that promise, and the version it reports now changes whenever your tools do.',
      },
    ],
  },
  {
    date: null,
    heading: 'Telling a step how hard to try',
    entries: [
      {
        kind: 'fixed',
        title: 'Number fields let you type the number you meant',
        detail:
          'Typing a negative offset into a date chip was close to impossible: clearing the field snapped it back to 0, which swallowed the minus sign, so “-3” came out as 3. Number fields now let you empty them while you type and settle on a valid value when you leave — and the browser’s stepper arrows, which crowded the smaller fields, are gone.',
      },
      {
        kind: 'changed',
        title: 'Tries are typed, not picked from a list',
        detail:
          'A step’s “give up after N tries” was a dropdown listing one option per allowed value, so an organization that raised the ceiling to 100 got a hundred-item list to scroll. It is now a number field.',
      },
      {
        kind: 'added',
        title: 'Steps can say which try they are on',
        detail:
          'Two new chips, “This try” and “Total tries”, read as 1 and 3 in an instruction — so a step can tell the agent “this is try 2 of 3, narrow the search this time” instead of repeating itself identically on every retry. They work in corrective guidance too, and the skills an agent calls now know when they are being retried.',
      },
    ],
  },
  {
    date: null,
    heading: 'Fewer round trips looking things up',
    entries: [
      {
        kind: 'changed',
        title: 'Look several field groups up in one go',
        detail:
          'Listing Jira fields took one filter per call, so an agent confirming a project’s schema — health, risk, story points — spent a call on each and could run out of budget before it had the whole picture. The lookup now takes a list of filters and reports the matches under each one. The full field list was always fetched and filtered locally anyway, so the extra filters cost nothing.',
      },
      {
        kind: 'changed',
        title: 'Look several people up in one go',
        detail:
          'Searching for Jira users took one name per call, so resolving a meeting’s attendees or a change’s reviewers cost a round trip each. The search now accepts a list of names and emails and reports the matches under each one — naming the people it could not find rather than quietly dropping them, and still answering with what it did find when a lookup fails partway.',
      },
    ],
  },
  {
    date: null,
    heading: 'Bitbucket joins the Atlassian connectors',
    entries: [
      {
        kind: 'added',
        title: 'Read your repositories and their history',
        detail:
          'Workspaces, projects, repositories, branches, tags, commits, diffs, file contents and full-text code search — everything needed to answer "what changed and where" without opening Bitbucket.',
      },
      {
        kind: 'added',
        title: 'Work pull requests end to end',
        detail:
          'List and read pull requests with their reviewers, build statuses and diffs; open, update, comment (inline on a line, or in a thread), approve, request changes, resolve threads, manage the task checklist, merge, and decline.',
      },
      {
        kind: 'added',
        title: 'Opening and merging ask you first',
        detail:
          'Creating a pull request, merging one, and starting a pipeline each come with a preview card: the details are laid out — branches, approvals, strategy — and nothing happens until you confirm on the card.',
      },
      {
        kind: 'added',
        title: 'Pipelines: watch, run, and stop',
        detail:
          'List runs, drill into a run’s steps, read a failing step’s log, start the default or a named custom pipeline on a branch or tag, and stop one mid-run.',
      },
      {
        kind: 'added',
        title: 'Branches and single-file commits',
        detail:
          'Create and delete branches, and commit a one-file change to a branch directly — enough for an agent to fix a typo or update a config without a clone.',
      },
      {
        kind: 'added',
        title: 'Projects and who can reach them',
        detail:
          'Create, rename and delete the projects repositories are filed under; list workspace members and see who holds what on a project or repository; grant and revoke per-repository access for members and groups. Project-level permission changes are the one thing Bitbucket refuses to integrations outright — the tools say so and point at the repository grant instead. All behind a separate administration capability, off by default.',
      },
      {
        kind: 'added',
        title: 'Connect with your own Bitbucket account',
        detail:
          'A fourth panel on the Atlassian card. Operators register a Bitbucket OAuth consumer under Connector setup; each person connects their own account and can narrow what Renkei uses — repositories, pull requests and pipelines each split into read and act.',
      },
    ],
  },
  {
    date: null,
    heading: 'Bigger agents, threaded WebEx replies',
    entries: [
      {
        kind: 'fixed',
        title: 'Drafting keeps up with a raised step limit',
        detail:
          'The organization setting can allow agents up to a hundred steps, but describing a change in prose still drafted against the old ceiling of twenty — an agent that had grown past it could not be revised that way at all. Drafting now offers and accepts exactly what saving will.',
      },
      {
        kind: 'added',
        title: 'WebEx agents know which thread a message belongs to',
        detail:
          'A message trigger now carries the thread root alongside the message id, so an agent can answer inside the thread it was spoken in — instead of posting a new top-level message next to it.',
      },
    ],
  },
  {
    date: null,
    heading: 'Service Management requests agents raise',
    entries: [
      {
        kind: 'fixed',
        title: 'Request descriptions keep their formatting',
        detail:
          'A description written in markdown was read by Jira as wiki markup, so every heading came out as a nested numbered list ("1. 1. Summary"). Descriptions on new Service Management requests now arrive as rich text and render as written — headings, lists and links intact.',
      },
      {
        kind: 'fixed',
        title: 'The reply confirms who a request was raised for',
        detail:
          'Creating a request on someone\'s behalf echoed back whatever reporter it was asked to set, even as a bare account id. The reply now reads the reporter Jira actually recorded, names them, and says "Reporter was not set" — naming who Jira left instead — on the occasions the value did not stick.',
      },
    ],
  },
  {
    date: null,
    heading: 'Hyland OnBase joins the connectors',
    entries: [
      {
        kind: 'added',
        title: 'Search and read your OnBase documents',
        detail:
          'Find documents by document type and keyword values — plain names like "Vendor" work, the tools translate them — or run the custom queries your OnBase admins have already saved. Read a document as text, get a download link for the original file, and see its keywords, notes and history.',
      },
      {
        kind: 'added',
        title: 'File documents into OnBase',
        detail:
          'Upload a file and archive it under a document type with keyword values, update the keywords on an existing document (only the fields you name change; everything else is preserved), add notes, and move a document to another type.',
      },
      {
        kind: 'added',
        title: 'Connect with your own OnBase account',
        detail:
          "Each person signs in on the organization's own Hyland identity provider from the Connectors page, and every tool acts with exactly that account's OnBase permissions — what OnBase would not show you, Renkei cannot either.",
      },
      {
        kind: 'added',
        title: 'OnBase setup for administrators',
        detail:
          "Operators enter the OnBase API server and identity provider on the connectors admin page, with a connection test that checks the values in the form before saving. A dedicated Renkei service reaches the OnBase servers inside the organization's network.",
      },
    ],
  },
  {
    date: '2026-08-26',
    entries: [
      {
        kind: 'changed',
        title: 'The step limit on an agent is now yours to set',
        detail:
          'How many steps one agent may hold was fixed at twenty. It is now an organization setting on the admin settings page, adjustable from one to a hundred. Checked when an agent is saved; agents already over a lowered limit keep running until they are next edited.',
      },
    ],
  },
  {
    date: '2026-08-26',
    heading: 'Narrowing what wakes a WebEx agent',
    entries: [
      {
        kind: 'added',
        title: 'A WebEx trigger can keep to direct messages, or keep them out',
        detail:
          'A trigger on posted messages can now watch only one-to-one conversations, only group spaces, or both — alongside the space, sender and keyword filters, and checked the same way, before the agent starts.',
      },
      {
        kind: 'added',
        title: 'Agents can wait for particular words in a WebEx message',
        detail:
          'List the keywords that should wake an agent, and choose whether any one of them is enough or all of them have to appear. Checked before the agent starts, so a message that does not match costs nothing.',
      },
      {
        kind: 'added',
        title: 'A WebEx trigger can leave out a space or a person',
        detail:
          '"Every space except this noisy one", or "anyone except the build bot" — exclusions sit alongside the existing "only these" lists and can be combined with them.',
      },
      {
        kind: 'changed',
        title: 'Activity says when a trigger filtered an event away',
        detail:
          'An event turned away by a trigger\'s own filters used to leave no trace, which made "why did my agent not run?" unanswerable. It is now recorded, so a filter doing its job is distinguishable from a filter that is wrong.',
      },
    ],
  },
  {
    date: '2026-08-26',
    heading: 'Searching your mail',
    entries: [
      {
        kind: 'fixed',
        title: 'Filtering mail by sender, flag or category works again',
        detail:
          'Every one of those searches came back as an error from Microsoft rather than results, unless a date range happened to be set as well. Bulk mail jobs that selected messages the same way were failing for the same reason, and are fixed with it.',
      },
      {
        kind: 'added',
        title: 'Mail can be filtered by who it was sent to',
        detail:
          'New To and Cc filters on the structured mail search and on bulk mail jobs. They are matched while scanning rather than by Exchange, which cannot filter on recipients, so pair them with a folder or date range when looking further back.',
      },
      {
        kind: 'fixed',
        title: 'A subject search stops dropping matches',
        detail:
          'When a page filled up, the remaining matches on that page were discarded and no later page could reach them. Every match found while scanning is now returned.',
      },
      {
        kind: 'changed',
        title: 'Microsoft errors say what was actually wrong',
        detail:
          'A rejected mail query reported only "Microsoft Graph answered 400". It now repeats the reason Microsoft gave.',
      },
    ],
  },
  {
    date: '2026-08-26',
    heading: 'Knowing what your agents did',
    entries: [
      {
        kind: 'added',
        title: 'Renkei tells you what your agents did',
        detail:
          'A ticket filed, an email sent, a page written, a meeting booked — each one arrives as a card in the corner while you work, and stays on a Notifications page with an unread count in the menu. Previously a finished run said only how many tools it called.',
      },
      {
        kind: 'added',
        title: 'Choose which of those you hear about',
        detail:
          'Preferences lists the real actions each application can take — created a page, declined an invitation, transitioned an issue — and you tick the ones worth interrupting you. Anything you switch off is never recorded, so turning it back on is not retroactive.',
      },
      {
        kind: 'changed',
        title: 'A notification opens the thing it is about',
        detail:
          'Clicking the card goes straight to the Jira issue, the email, the Confluence page or the meeting. Destructive actions carry no link, because there is nothing left to open.',
      },
      {
        kind: 'added',
        title: 'Notifications are kept for a set number of days',
        detail:
          'An organization setting, fourteen days by default. Older ones are swept away; the runs they came from are unaffected.',
      },
    ],
  },
  {
    date: '2026-08-26',
    heading: 'Deciding when an agent runs',
    entries: [
      {
        kind: 'added',
        title: 'Agents can be scoped to a space, a sender or a subject',
        detail:
          'An event trigger gains "Only run when…" — particular WebEx spaces, named senders, a sender domain, words in a subject. The check happens before the agent starts, so a filtered event costs nothing at all and no model is asked to judge it.',
      },
      {
        kind: 'changed',
        title: 'Describing a filter in prose keeps it',
        detail:
          'Saying "when Priya emails about invoices" used to produce an agent that ran on every email. The filter now survives into the draft.',
      },
      {
        kind: 'changed',
        title: 'The canvas says which steps call a model',
        detail:
          'Steps that run as fixed code carry a small chip in their corner. Most of a flow is code; the marker makes it obvious where the cost and the uncertainty actually are.',
      },
    ],
  },
  {
    date: '2026-08-26',
    heading: 'Jira components',
    entries: [
      {
        kind: 'fixed',
        title: 'Components land on Jira tickets',
        detail:
          'Asking for a component on a new or updated issue used to be dropped in silence — Jira refused the field, Renkei retried without it, and reported success on a ticket that had no component. Both create and update now set it, and a name the project does not have is reported back alongside the ones it does.',
      },
      {
        kind: 'added',
        title: 'Service Management requests can carry components too',
        detail:
          'And there is now a way to ask which components a given request type will accept, since a service desk form does not necessarily offer every component its project has.',
      },
    ],
  },
  {
    date: '2026-08-25',
    heading: 'UI consistency and silent failures',
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
          'Two across on a wide screen, each card wide enough for the products nested inside it, with the MCP endpoint URL on a full-width row above them rather than buried in the flow.',
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
