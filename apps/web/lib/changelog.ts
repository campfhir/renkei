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
    date: '2026-09-18',
    heading: 'A chat asks before it acts',
    entries: [
      {
        kind: 'added',
        title: 'A chat pauses before it changes something',
        detail:
          'When a chat is about to create a Jira issue, send a WebEx message, write a memory note, save a file or push a commit, it stops and asks. The ask appears in the thread where the reply paused — Allow once, Always allow or Deny — and a notification reaches you if you are not looking. Deny, or leave it an hour, and the assistant says what it was going to do instead of doing it. Stop still cancels the turn, and the ask is still there after a reload.',
      },
      {
        kind: 'added',
        title: 'Decide per tool what a chat may do',
        detail:
          'Preferences now lists every tool that acts on your behalf, folded by connector, with three answers for each: Ask, Allow or Block. Set a whole connector at once, or one tool before it has ever been called. A blocked tool is withheld from the model entirely, and an “Always allow” you gave from a chat shows up here where it can be taken back.',
      },
      {
        kind: 'changed',
        title: 'A system notification opens what it is about',
        detail:
          'Clicking a notification now marks it read and takes you to the thing itself — the issue in Jira, the space in WebEx — or to its place in Renkei when the new “open in the source application” preference is off. A browser push opens the source beside your Renkei tab rather than over it; a push about a chat opens the chat.',
      },
    ],
  },
  {
    date: '2026-09-18',
    heading: 'WebEx notes that show as unread',
    entries: [
      {
        kind: 'added',
        title: 'A WebEx bot that leaves you notes',
        detail:
          'Your organization can add a WebEx bot under Connector setup. With one, every note Renkei leaves you — a digest, a reminder, an agent saying what it did — arrives as a direct message from the bot, so WebEx shows it unread and notifies you. A note posted to your own "Note to Self" space is yours, which is why WebEx has always shown those as already read; without a bot, notes still go there.',
      },
    ],
  },
  {
    date: '2026-09-18',
    heading: 'Voice',
    entries: [
      {
        kind: 'added',
        title: 'Replies read aloud',
        detail:
          'When your organization has set up a speech service, a speaker button in the chat reads each reply as it arrives — turn it on for every chat, or press Listen under any one reply. Pick the voice, the pace and the language under Preferences or from the speaker menu itself.',
      },
      {
        kind: 'added',
        title: 'Voice conversations',
        detail:
          'Start a voice conversation from the speaker menu and talk instead of typing: each thing you say is sent as a message, the reply is read back to you, and speaking over it stops it so you can steer. Works in any chat, including chats inside projects and code projects, and the chat keeps the whole conversation in writing.',
      },
      {
        kind: 'added',
        title: 'Dictate into the box',
        detail:
          'A microphone beside the message box turns what you say into text there — pause, and your words appear to read over, fix and send like anything typed. The lighter way to talk to the chat when you do not want the full-screen conversation.',
      },
      {
        kind: 'added',
        title: 'A wave that moves with the voice',
        detail:
          'In a voice conversation the voice is drawn as a wave in a soft glow that swells with your microphone while you talk and with the speaker while the assistant does; it drifts gently when there is nothing to hear. The assistant and you each have your own colour — a rainbow and emerald to start; pick either, or one hue, from the speaker menu or under Preferences.',
      },
      {
        kind: 'added',
        title: 'Voice under Connector setup',
        detail:
          'Administrators configure the speech service — a region or custom endpoint, a key, a default voice and language — under Connector setup, and can test it from there. Until it is configured and enabled, nothing about voice is shown to anyone.',
      },
    ],
  },
  {
    date: '2026-09-18',
    heading: 'Chats, found and read more easily',
    entries: [
      {
        kind: 'added',
        title: 'Search chats by what was said',
        detail:
          'The sidebar’s search box used to match only titles and project names. It now also finds chats by a phrase in your messages or the replies, and shows a snippet around the match under the chat’s title. Tool calls, tool results and thinking are never searched.',
      },
      {
        kind: 'changed',
        title: 'Tables read as cards on a phone',
        detail:
          'A table in a reply with more than a couple of columns was squeezed until keys and dates wrapped one character per line. On a narrow screen each row is now a card of “Header: value” lines; wider screens keep the table.',
      },
      {
        kind: 'added',
        title: 'Copy a table out of a reply as a table',
        detail:
          'Selecting part of a reply that includes a table and copying it now puts a Markdown table on the clipboard — column names included, even for a partial selection or the phone’s card layout — ready to paste into Jira, Confluence or another chat.',
      },
      {
        kind: 'changed',
        title: 'A new chat exists before you type',
        detail:
          '“+ New” now opens a chat straight away, so the first Send is an ordinary message: no reload of the thread mid-reply, and nothing typed or queued is lost. An empty chat stays out of the sidebar until its first message, and one left empty is cleaned up a day later.',
      },
      {
        kind: 'added',
        title: 'New chat from the “⋯” menu, and Clear search',
        detail:
          'A chat’s overflow menu now offers New chat, landing in the same project when the chat has one. The sidebar’s filter menu gains Clear search whenever the search box has text.',
      },
    ],
  },
  {
    date: '2026-09-18',
    entries: [
      {
        kind: 'fixed',
        title: 'No more flash of the app before the sign-in page',
        detail:
          'Opening any page while signed out — or with a session that had expired — could briefly show the menu and a loading skeleton before jumping to sign in. The check now happens before anything is sent, and you come back to the exact page you asked for, filters included.',
      },
      {
        kind: 'fixed',
        title: 'Service desk request types by name',
        detail:
          'Creating a service desk request, listing its components or asking for a request type’s fields with the type’s name — “Application Error” rather than its number — failed with a conversion error. A name now works everywhere a request type is asked for, and an unknown name is answered with the types the desk offers.',
      },
      {
        kind: 'fixed',
        title: 'Agents see whole tool results',
        detail:
          'An agent step was handed each tool result cut off at about 8,000 characters with a bare “[truncated]” marker, so a long component list or a page of search results reached the model mid-item and looked complete. The cap is now the same generous one a chat uses, and when it does bite the marker says how much was cut and tells the model to narrow or page. The debug paste records how much of each result the model read.',
      },
    ],
  },
  {
    date: '2026-09-17',
    heading: 'Jira comments and search results',
    entries: [
      {
        kind: 'fixed',
        title: 'Jira comments arrive whole',
        detail:
          'Listing an issue’s comments clipped each one at 300 characters, so an incident timeline or a pasted log could be seen only up to its first paragraph. Comments now come through in full, with their exact timestamp and a mark when they were edited, and a long thread is paged rather than cut.',
      },
      {
        kind: 'added',
        title: 'Edit a Jira comment in place',
        detail:
          'Fixing a typo in a comment meant deleting it and posting again. A new Jira tool edits a comment where it is, keeps a service desk internal note internal, carries any visibility restriction across, and returns the previous text so the edit can be undone.',
      },
      {
        kind: 'fixed',
        title: 'Extra fields on a Jira search read as text',
        detail:
          'Asking a Jira search for an extra field such as the description returned the head of Jira’s raw document tree, cut at 500 characters. Extra fields now render as Markdown, whole, the way an issue’s own page already did.',
      },
    ],
  },
  {
    date: '2026-09-17',
    entries: [
      {
        kind: 'added',
        title: 'Ask for a Jira issue’s change history',
        detail:
          'A new Jira read tool lists every change on an issue — status, assignee, priority, sprint, estimates, custom fields — with when it happened and who made it. Narrow it to one field or a date range, and ask for the newest changes first.',
      },
    ],
  },
  {
    date: '2026-09-17',
    heading: 'Organization usage, per person',
    entries: [
      {
        kind: 'added',
        title: 'See one person’s usage on Organization usage',
        detail:
          'Pick a person to scope the whole page to them: their tokens by surface and by model, agent runs, tool calls, the trend over time, their top agents and tools — and, in place of the active-user rate, how many days of the period they were active, drawn as a small calendar of shaded squares. The top-users list keeps the top five and shows where the chosen person ranks below them.',
      },
      {
        kind: 'added',
        title: 'Today and yesterday on Organization usage',
        detail: 'Two more periods beside 7, 30 and 90 days. Either draws the day by the hour.',
      },
      {
        kind: 'added',
        title: 'Tokens by model on Organization usage',
        detail:
          'Which models the spend went to over the period, with each one’s share and call count — org-wide, or for the chosen person.',
      },
      {
        kind: 'changed',
        title: 'People has become Access, and Organization usage',
        detail:
          'Who is connected to what is now the Access page: one table of every person and the connectors they hold, with the disconnect button on the row. What else the People page said about someone — their groups and the agents they own — sits above that person’s usage when they are picked on Organization usage. The People page and its per-person pages are gone; the old Grants link lands on Access.',
      },
    ],
  },
  {
    date: '2026-09-17',
    heading: 'Knowledge search',
    entries: [
      {
        kind: 'fixed',
        title: 'Searching several sources no longer loses the good matches',
        detail:
          'A search across every source, or across a quiet one and a noisy one, could return poor hits or nothing while the same query against the quiet source alone found strong matches. The index is now searched more widely before the source and date filters apply, so the close match is found wherever it sits. Applies to the search page and to agents and chats searching knowledge alike.',
      },
      {
        kind: 'changed',
        title: 'The search page fits a phone',
        detail:
          'The controls sit in three rows — the query, then period and limit, then sources — instead of one row that wrapped unpredictably. The query-syntax help is behind an (i) button, shown on hover or a tap. The “N withheld” counts under the results are gone.',
      },
      {
        kind: 'fixed',
        title: 'Rename, move, share and delete dialogs from the chat list work again',
        detail:
          'On a desktop the dialog opened from a chat row’s “⋯” menu looked see-through and could not be clicked; on an iPhone it was clipped to the width of the drawer. The dialogs now open over the whole page.',
      },
    ],
  },
  {
    date: '2026-09-16',
    entries: [
      {
        kind: 'added',
        title: 'Copy a reply',
        detail:
          'A Copy button under each assistant reply puts just its prose on the clipboard — no thinking, no tool calls — the way code blocks could already be copied.',
      },
      {
        kind: 'added',
        title: 'Told when a chat or agent is shared with you',
        detail:
          'Two new notifications, on by default in the app: someone sharing a chat with you, and someone sharing an agent. Under Notifications you can also turn on a desktop push when a reply lands in one of your chats while no Renkei tab is in front.',
      },
      {
        kind: 'fixed',
        title: 'Approval and question cards now reach the notification feed',
        detail:
          'An agent asking for approval or asking a question only ever sent email or WebEx, though the preferences page promised “Always” in the App column. Both now appear in the in-app feed and can push, as the page said.',
      },
      {
        kind: 'changed',
        title: 'Knowledge search is faster and never hangs',
        detail:
          'Semantic search now hits an index instead of scanning every chunk, many more searches can run at once, and a search stuck behind a queue gives up after ten seconds with a clear failure rather than waiting indefinitely.',
      },
      {
        kind: 'fixed',
        title: 'The Code page recognizes a full Bitbucket connection',
        detail:
          'With every Bitbucket permission approved, the Code page could still say the connection lacked repository, branch and pull request access and refuse to create a code project, while the Connectors page showed it connected. Bitbucket reports its scopes in its own vocabulary; the Code page now reads them the way the rest of the app does.',
      },
      {
        kind: 'changed',
        title: 'Colleagues looked up in the live directory, several at once',
        detail:
          'The directory tool takes a list of names or addresses in one call, so finding a few people no longer costs a call each. A chat also prefers the directory over indexed documents or messages for someone’s profile or contact details, and prefers a live tool over knowledge search for anything very recent.',
      },
    ],
  },
  {
    date: '2026-09-16',
    entries: [
      {
        kind: 'added',
        title: 'Agents can render documents too',
        detail:
          'A code chat could already turn Markdown into a Word document or PDF, headings into a slide deck, or a table into a spreadsheet. Any agent step can now do the same on its own, staging the file in the sandbox for another connector — SharePoint, OneDrive, a Jira attachment, a network share, OnBase — to pick up and send on.',
      },
      {
        kind: 'changed',
        title: 'Remembering is its own step, not a side effect',
        detail:
          'A step used to attach a memory note to the same call that declared it had succeeded, failed or was skipped, so a routine outcome could quietly leave a note behind. Remembering is now a separate, free tool call a step makes only when it means to — an agent that must not repeat itself across runs now needs to say so and remember the fact explicitly.',
      },
      {
        kind: 'fixed',
        title: 'Long text on an agent’s page no longer breaks the layout',
        detail:
          'A memory entry, an Improve finding, or a trigger’s last error message with nothing to break on — a long id, URL or path — could overflow its box and push the page out of shape. These now wrap like everything else.',
      },
    ],
  },
  {
    date: '2026-09-15',
    heading: 'Mirth Connect joins the connectors',
    entries: [
      {
        kind: 'added',
        title: 'Connect with your own Mirth account, per server',
        detail:
          'An organization registers any number of Mirth Connect instances — dev, test, prod, one per site — and each person connects their own Mirth username and password to whichever they use, from the Connectors page. The credential is checked against the live server before it is stored, so a wrong password fails immediately rather than later.',
      },
      {
        kind: 'added',
        title: 'Permissions you actually recognize',
        detail:
          'Instead of one read/act/destructive ladder, pick permissions by area — channels, messages, alerts, code templates, users, events, server — with Read only, Operate, Develop and Everything presets to start from. Mirth’s own server-side roles still have the final say.',
      },
      {
        kind: 'added',
        title: 'Deleting, purging or restoring asks first',
        detail:
          'Deleting a channel, purging messages, deleting an alert, restoring the server and similar irreversible actions always show a preview card to confirm, whatever permissions are granted.',
      },
      {
        kind: 'added',
        title: 'Most of the Mirth REST API, reachable by name',
        detail:
          'Channels, messages, alerts, code templates, users, the event log and server configuration — hand-written tools for the everyday ones and generated tools covering the rest of Mirth’s roughly two hundred routes. Say a channel, alert or code template by name, or “prod” for an instance, and Renkei resolves it; replies naming an id show its name too.',
      },
    ],
  },
  {
    date: '2026-09-15',
    heading: 'Long chats keep going',
    entries: [
      {
        kind: 'added',
        title: 'A long chat compacts itself',
        detail:
          'Once a chat’s history grows past a size the model can comfortably hold, Renkei folds everything but the most recent messages into one rolling summary — identifiers, file paths, commands and their outcomes, decisions, open items — and keeps going instead of failing or degrading. It happens on its own before a turn would overflow, the model can call it itself, or you can ask directly: type /compact, or pick “Compact this conversation” from the / menu. A card shows the fold in progress, and a small marker stays once it is done.',
      },
      {
        kind: 'added',
        title: 'Send your next message while one is still running',
        detail:
          'Sending used to be blocked until the current reply finished. It now queues instead — shown in the composer, each item removable on its own or all at once — and the moment the running turn ends, the next queued message goes out with no click needed.',
      },
    ],
  },
  {
    date: '2026-09-15',
    entries: [
      {
        kind: 'fixed',
        title: 'A connected Bitbucket account could end up with no tools',
        detail:
          'Renkei trusts a connection’s scopes by matching the ones it requested against the ones the provider reports as granted — but Bitbucket reports granted scopes under a vocabulary that shares nothing with the names Renkei requests, so the match came back empty and a perfectly healthy connection could silently offer no Bitbucket tools at all. A connection is now trusted as granted unless at least one recognized name comes back, the same rule already used for providers that cannot narrow scopes at consent. Its label on the Connectors page also read as the raw id “atlassian-bitbucket” rather than “Bitbucket”; both are fixed together.',
      },
      {
        kind: 'fixed',
        title: 'A stuck tool call no longer hangs the whole reply',
        detail:
          'A code chat’s own sandbox and file tools had no timeout of their own, so one that hung kept the whole turn waiting forever; it now times out on the same budget every other tool call gets, and the turn moves on. A reply cut off mid tool call — by an error, a timeout, or Stop — now shows the arguments that had actually streamed in rather than an empty call.',
      },
      {
        kind: 'fixed',
        title: 'Long unbroken text no longer overflows chat, cards or logs',
        detail:
          'A URL, token or hash with nowhere to break could spill out of its bubble, card or panel instead of wrapping. Chat messages, cards, memory and library views, an agent’s run-live view, and the logs viewer now all wrap it in place.',
      },
      {
        kind: 'changed',
        title: 'Code projects require a working Bitbucket connection',
        detail:
          'A project could be created without the Bitbucket scopes the feature actually needs, and only fail once a chat tried to clone, push or open a pull request. Creating one now checks your connection first and names exactly which Connectors-page boxes to tick; inside a code project’s chat, Bitbucket can no longer be switched off.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Sandbox reliability across restarts and replicas',
    entries: [
      {
        kind: 'fixed',
        title: 'A dropped sandbox checkout no longer ends the chat',
        detail:
          'If the sandbox’s checkout of your repository went missing mid-turn — swept from disk, the sandbox restarted, a replica lost track of it — every code tool call failed and the chat was stuck. Tools now re-clone the checkout, or adopt a fresher one another chat already made, and run the same call again in it, saying so in the reply; past two recoveries in one turn they stop and say to report it rather than loop. A new code_clone tool lets the assistant check and recover the checkout on demand.',
      },
      {
        kind: 'fixed',
        title: 'Browser tool sessions survive a restart or a different replica',
        detail:
          'The browser tool’s cookies, current page and element references lived only in the memory of whichever sandbox replica handled the call — a later call landing on a different replica, or a restart, meant starting the browser task over with no explanation. Sessions are now saved, encrypted, to the shared sandbox disk after every action and picked up by whichever replica runs next; typed secrets are still never saved this way.',
      },
      {
        kind: 'fixed',
        title: 'An unlocked secret stays unlocked across a restart',
        detail:
          'Unlocking a passphrase-protected browser secret only unlocked it on the sandbox replica handling that call — a later call on a different replica, or a worker restart, found it locked again well within its own unlock window. The unlocked key is now written to the shared disk, sealed to its owner, for the rest of that window; locking it anywhere locks it everywhere.',
      },
      {
        kind: 'fixed',
        title: 'Fixed a permissions bug that could block a code chat from its own workspace',
        detail:
          'The sandbox creates each tenant’s workspace directory meant to be reachable but not listable; a safety measure elsewhere in the worker was silently sealing it further at creation, so a different caller’s process could fail to even reach its own subdirectory. The directory is now set to the permissions it was always meant to have.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Dark mode keeps up, and pages stop flashing blank',
    entries: [
      {
        kind: 'fixed',
        title: 'Dark mode applies immediately and stays in sync',
        detail:
          'Switching tenants, recovering from a hydration error, or reopening a backgrounded tab could leave the page in light styling regardless of your saved preference, and picking a theme in Preferences did not reach your other open tabs. The theme is now force-applied on every mount, tabs stay in sync with each other, and Auto re-checks the system theme whenever a tab regains focus or is restored, not only when it changes live.',
      },
      {
        kind: 'added',
        title: 'Loading skeletons instead of a blank page',
        detail:
          'Most pages under Admin, Agents, Chat, Code, Connectors, Files, Knowledge, Logs, Notifications and usage now show a placeholder while their data loads. A button that triggers a refresh — enabling an agent, running it now, cancelling a run — also stays in its busy state until the page’s data has actually updated, instead of looking clickable again before anything changed.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'The sidebar grows up',
    entries: [
      {
        kind: 'added',
        title: 'Icons for every row in the menu',
        detail:
          'Home, Agents, Knowledge, Files, Chat, Projects, Code, Prompt libraries, Memory, Notifications, Preferences, Connectors, Batch jobs, My usage, Activity, Organization, About — each row in the left-hand menu now carries a small icon next to its label, not just text.',
      },
      {
        kind: 'changed',
        title: 'Chat rows are simpler, and code chats join the list',
        detail:
          'Rows no longer spell out a project name or owner underneath the title. A code project’s chats, previously visible only from the project’s own page, now appear in this same list alongside every other chat, marked with a small project indicator instead.',
      },
      {
        kind: 'fixed',
        title: 'Signed-out visitors no longer see a flash of the page first',
        detail:
          'Activity, Tools and My usage could render before the sign-in check that would redirect a signed-out visitor away had finished, showing a flash of the real page first. The check now runs before anything renders.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Organization usage, and your own',
    entries: [
      {
        kind: 'added',
        title: 'An Organization usage page for operators',
        detail:
          'Tenant-wide token spend broken down by surface — chat, chat projects, code projects, agents — who is using it, and leaderboards including which agents get the most done per thousand tokens.',
      },
      {
        kind: 'added',
        title: 'My usage gets the same breakdown',
        detail:
          'The token-by-surface chart and a most-efficient-agents leaderboard now sit on your own usage page too, scoped to your own agents.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Creating and naming repositories from Renkei',
    entries: [
      {
        kind: 'added',
        title: 'Create a brand-new Bitbucket repository from the project form',
        detail:
          'A new Code project used to need an existing repository, found by browsing or searching. “Create new” now makes an empty, private repository in the workspace and project you choose, right from the form, and uses it exactly like a browsed one from there.',
      },
      {
        kind: 'added',
        title: 'A code project takes its name from the repository',
        detail:
          'Naming a project used to be required and separate from picking its repository. The name now defaults to the repository’s own name and is optional to override; the project page’s title itself can be renamed in place with a double-click, or the pencil that appears on hover.',
      },
      {
        kind: 'fixed',
        title: 'New code projects could not list some Bitbucket workspaces',
        detail:
          'The project-creation form’s workspace browser called an older Bitbucket endpoint that a newer style of connected token gets refused for, even though the same account’s chat tools worked fine. Both now go through the same lookup, with the same fallback.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Notifications: read them all, and reach back further',
    entries: [
      {
        kind: 'added',
        title: 'Mark every notification as read at once',
        detail:
          'One button marks every unread notification, not just the ones currently loaded on the page.',
      },
      {
        kind: 'added',
        title: 'Load older notifications',
        detail:
          'The page used to show only the newest page with no way back. Scroll near the bottom and a “Show more” button pages backward, up to a hundred at a time.',
      },
      {
        kind: 'fixed',
        title: 'Every notification opens something',
        detail:
          'A saved note, a created card, or a run failure with no obvious link of its own used to be an unclickable dead card. It now opens the run it came from.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Code projects: a repository to work in',
    entries: [
      {
        kind: 'added',
        title: 'Code projects',
        detail:
          'Under Chat, a new Code page holds projects with a Bitbucket repository on them: pick the repository by browsing your workspaces and projects, or by searching by name, and every chat inside the project can read, search and edit the code, run its own tests and builds, commit, push, and open a pull request — with Jira and your other connectors beside it. Code chats run as long working sessions rather than under an ordinary chat’s limits.',
      },
      {
        kind: 'added',
        title: 'A .env the model never sees',
        detail:
          'Paste the repository’s .env when you make the project, or replace it later from the project page or the chat’s Environment button. Values are sealed on the sandbox and never shown again — not to you, not to the model; commands get them in their environment, and they are masked out of everything the model reads. Only the names are listed.',
      },
      {
        kind: 'added',
        title: 'The first chat clones the repository, and says so',
        detail:
          'Nothing is cloned when a project is made. The first message in a chat clones the repository into the sandbox with your own Bitbucket access, shown right under your message as “Cloning the repository…” and then “Cloned the repository” with the result. Before that the project page already shows the file tree and README straight from Bitbucket, with the branch the project points at.',
      },
      {
        kind: 'added',
        title: 'Every edit shows its diff',
        detail:
          'When the chat writes or edits a file, the call in the transcript opens to that file’s diff, side by side on a wide screen and stacked on a phone, with +added −deleted on the line. A Changes button in the chat’s title bar carries the checkout’s uncommitted totals and opens every diff with the context lines you want, and a button there asks the chat to commit, push and open a pull request.',
      },
      {
        kind: 'added',
        title: 'Add files to the repository from the chat',
        detail:
          'An Add files button in a code chat takes files you pick or drop and puts them in the repository’s checkout as untracked files the chat can read, use and commit.',
      },
      {
        kind: 'added',
        title: 'The chat can hand work to sub-agents',
        detail:
          'A code chat can give a self-contained task, with its own instructions, to a sub-agent that works in the same repository and reports back — for independent parts of a larger change, or an investigation that would flood the conversation. The chat you are talking to stays in charge of committing and pushing.',
      },
      {
        kind: 'added',
        title: 'A developer’s brief by default',
        detail:
          'A new code project starts with standing instructions — read the repository first, work test-first, keep changes small and complete, run the project’s own checks, keep the docs true, commit with clear messages — shown in the form and on the project page so you can change them before or after.',
      },
      {
        kind: 'changed',
        title: 'Git calls read as git',
        detail:
          'Commit, push, pull, clone, branch, merge and pull request calls in a chat carry their own names and glyphs in the transcript, and a diff is marked ±.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'Connectors you choose, a theme you choose, and a few fixes',
    entries: [
      {
        kind: 'added',
        title: 'Your Connectors page shows what you use',
        detail:
          'The Connectors page lists the connectors you added or connected, and the rest sit behind “Add connector” — a search over what your organization offers, by name or by what you would type (“email”, “tickets”). Administrators set up connectors from a searchable catalog, one page per connector, and can limit a connector to people in named sign-in groups.',
      },
      {
        kind: 'added',
        title: 'Light, dark, or follow the system',
        detail:
          'Preferences gains an Appearance setting. The choice is remembered in the browser too, so a page never flashes the wrong theme while it loads.',
      },
      {
        kind: 'added',
        title: 'WebEx attachments can be staged and read',
        detail:
          'A WebEx message’s attachments can be pulled into your sandbox scratch space with your own access, so their text can be read and the file forwarded into Jira, OnBase or Confluence. Message lists now say when a message carries files.',
      },
      {
        kind: 'fixed',
        title: 'Jira update notifications link to the ticket',
        detail:
          'A notification for an issue the assistant updated rendered as plain text; it now opens the issue like the ones for created, commented and transitioned issues.',
      },
      {
        kind: 'fixed',
        title: 'WebEx room lists were cut at thirty',
        detail:
          'Listing rooms walks every page and can be searched by title, with a total and an offset for the next page, instead of showing the first thirty and no more.',
      },
      {
        kind: 'fixed',
        title: 'A new chat kept the tools you picked',
        detail:
          'Toggling the toolset before a chat’s first message was lost the moment the chat was created. It is kept now — and the assistant is nudged to look up a tool it has not been offered up front before asking you for something a lookup could supply.',
      },
      {
        kind: 'changed',
        title: 'Tool calls fold without boxes',
        detail:
          'Thinking and tool calls in a chat fold on a plain line with a chevron rather than a boxed card.',
      },
    ],
  },
  {
    date: '2026-09-14',
    heading: 'OnBase Administration: who can see what',
    entries: [
      {
        kind: 'added',
        title: 'Find OnBase users and user groups',
        detail:
          'New tools list user groups and users by name and id, show who is in a group and which groups a person belongs to, and answer "who may see this document type?" from either side — so a name like "Clinical Staff" is enough wherever OnBase wants a group id.',
      },
      {
        kind: 'added',
        title: 'Grant a document type to user groups',
        detail:
          'A document type nobody has been granted is invisible in every OnBase client and in OnBase Configuration, even though it exists and has an id. Grant it (or a document type group) to user groups by name; existing grants are read first and kept, so naming one group never revokes the others.',
      },
      {
        kind: 'changed',
        title: 'Creating a document type warns when nobody can see it',
        detail:
          'Creating a document type now takes user groups by name, and when none are given the answer says plainly that the document type will not show up for anyone until one is granted — instead of reporting a clean success.',
      },
      {
        kind: 'changed',
        title: 'OnBase ids come with their names',
        detail:
          'Every OnBase Administration record now carries the name beside each id it references — the document type group, disk group, file type, keyword type, user group or user — and people are shown with their real name and email where the account can read them. A reference to something that no longer exists says so instead of leaving a bare number.',
      },
      {
        kind: 'added',
        title: 'See your own OnBase rights',
        detail:
          'One tool shows the product rights, configuration rights and privileges the connected account holds — the first thing to check when OnBase refuses a change, or to see whether a licensed module such as Medical Records is enabled.',
      },
    ],
  },
  {
    date: '2026-09-14',
    entries: [
      {
        kind: 'added',
        title: 'Agent oversight as cards, with token spend per agent',
        detail:
          'Each agent is a card: on/off switch, owner, last run, runs and failures, tokens in with the cached part, tokens out — for the period you pick, now including Yesterday — and a sort puts the most expensive agents first instead of a click into each one. An org card above splits the total by model.',
      },
      {
        kind: 'added',
        title: 'An agent’s tokens broken down by model and by step',
        detail:
          'An agent’s usage is a stack of cards for the period you pick: overall, by model, and by step — numbered as the steps outline numbers them, with a model filter. Both the owner’s page and the admin view have it.',
      },
      {
        kind: 'changed',
        title: 'Token usage records which model was used',
        detail:
          'Every model call now records the provider and model it went to, so spend can be read against each model’s price rather than as one undifferentiated count. Usage recorded before this cannot be attributed and is shown as such.',
      },
      {
        kind: 'added',
        title: 'Cached prompt tokens shown on their own',
        detail:
          'How much of the input the model served from its prompt cache — billed at a fraction of the input price — now shows beside every tokens-in figure, on Agent oversight, on an agent’s usage and in the by-model split.',
      },
    ],
  },
  {
    date: '2026-09-09',
    entries: [
      {
        kind: 'added',
        title: 'The assistant remembers things about you',
        detail:
          'Outside a project, tell it to remember something and the note carries into every chat you have, not just this one. See what it has saved, add a note yourself, edit or forget one, under Memory in the sidebar next to Projects and Prompt libraries.',
      },
      {
        kind: 'added',
        title: 'The assistant can look back at your other chats',
        detail:
          'Ask about something from a different conversation and it can search your other chats by title and content, or open one and read it back. A project’s own chats keep their own separate memory and are never searched this way.',
      },
      {
        kind: 'added',
        title: 'Your agents can see what is remembered about you',
        detail:
          'An agent you run can read the same memory your chats keep about you — read-only: it can never add to it or erase it, only your own chats and the Memory page can do that.',
      },
    ],
  },
  {
    date: '2026-09-04',
    entries: [
      {
        kind: 'added',
        title: 'Resend or edit a message you sent',
        detail:
          'Under any of your messages in a chat: Resend sends it again as it was, Edit puts it back in the box to change first. Either way the replies after it are removed and the model answers afresh.',
      },
      {
        kind: 'added',
        title: 'An Artifacts button for the files the assistant produces',
        detail:
          'Whenever a tool the assistant used hands back a file — a screenshot, a rendered PDF, a download — it is kept with the chat. An Artifacts button in the chat’s title bar lists them, each ready to download.',
      },
      {
        kind: 'added',
        title: 'Set up file storage for the organization',
        detail:
          'Operators configure the Azure Blob Storage account that holds chat uploads and the files the assistant produces under Organization → Storage, with a connection test before saving. Without storage, the chat offers no uploads and the assistant is told not to produce files.',
      },
      {
        kind: 'added',
        title: 'Save or copy a produced file',
        detail:
          'Pick a file under Artifacts to download it, or copy it to a network share you have connected, written with your own credentials.',
      },
      {
        kind: 'added',
        title: 'Archive chats',
        detail:
          'Archive a chat from its row menu to tuck it away without deleting it. The funnel in the chat list’s search box chooses whether you see active chats, archived ones, or both; Unarchive restores one.',
      },
      {
        kind: 'changed',
        title: 'Your chats are always a click away',
        detail:
          'The chat list and its search now sit in the menu on every page, and each chat shows the project it belongs to underneath its name.',
      },
      {
        kind: 'changed',
        title: 'My usage counts your chats',
        detail:
          'Tokens spent in the chat were already part of your totals; the Tokens card now says how many of them the chat accounted for.',
      },
      {
        kind: 'changed',
        title: 'Chat picks up where you left off',
        detail:
          'Chat in the menu opens your most recent chat; the “+ New” beside it starts a fresh one. With no chats yet, Chat starts a new one.',
      },
      {
        kind: 'fixed',
        title: 'Fields no longer zoom the page on a phone',
        detail:
          'Tapping into a search box, a form field or the chat’s message box on an iPhone used to zoom the whole page in and leave it there. Every field is now set at a size the phone does not zoom for.',
      },
      {
        kind: 'fixed',
        title: 'The chat’s message box stays above the keyboard',
        detail:
          'On a phone the on-screen keyboard used to cover the message box and the end of the conversation. The chat now shrinks to the space above the keys, so what you are typing and the latest reply stay in view.',
      },
    ],
  },
  {
    date: '2026-09-04',
    heading: "Chat with your organization's models",
    entries: [
      {
        kind: 'added',
        title: 'A chat, under "Chat" in the menu',
        detail:
          "Talk to the models your organization has configured, with your own tool access: the model's reply streams in as it is written, its reasoning and every tool call it makes show up inline, and you can stop it mid-answer. Chats are kept, grouped by day in the menu, and can be renamed, archived or deleted. Switch models at any point in a conversation.",
      },
      {
        kind: 'added',
        title: 'Files in chats',
        detail:
          'Drop, paste or pick files into a message. The model reads documents, spreadsheets and PDFs, and can stage a file into your sandbox to work on it. Files can be downloaded back from the chat at any time.',
      },
      {
        kind: 'added',
        title: 'Projects: shared context across chats',
        detail:
          'A project holds instructions, files and a memory that every chat inside it sees, and its members each chat with that same context. Share a project with named people as viewers or editors, or publish it to the whole organization. Move an existing chat into a project (or back out) whenever you like.',
      },
      {
        kind: 'added',
        title: 'Prompt libraries',
        detail:
          'Save the prompts you keep retyping into a library, share it with named people or the whole organization, and insert any prompt into a chat by typing "/" in an empty message box.',
      },
      {
        kind: 'added',
        title: 'Share a chat read-only',
        detail:
          'Share a chat with named people the way you share an agent. They can read it and watch it live, but only you can continue it.',
      },
      {
        kind: 'added',
        title: 'Choose which tools a chat may use',
        detail:
          'Each chat starts with a small core (knowledge search and the sandbox) and you switch other connectors on per chat or per project. Everything a chat does with a tool is done as you, under the same limits and logging as any other tool call.',
      },
      {
        kind: 'added',
        title: 'A retention window for chats',
        detail:
          'Admins can set how many days chats are kept (Settings). The default keeps them until deleted.',
      },
    ],
  },
  {
    date: '2026-09-04',
    heading: 'OnBase Administration joins the connectors',
    entries: [
      {
        kind: 'added',
        title: 'Create and configure document types and keyword types',
        detail:
          'New tools create document types, keyword types, and the groups they belong to, and change which keywords a document type has — reading current values first and merging your change in, so naming one keyword to update never erases the others.',
      },
      {
        kind: 'added',
        title: 'A configuration change history',
        detail:
          'See who changed what and when — a document type renamed, a keyword type’s settings adjusted — filterable by item, person, or date.',
      },
      {
        kind: 'added',
        title: 'Connect with your own OnBase Administration account',
        detail:
          'A separate connection from OnBase document access above, on its own card under Hyland: sign in on your organization’s identity provider and every configuration change is made as you. Connecting one does not connect the other.',
      },
      {
        kind: 'added',
        title: 'OnBase Administration setup for administrators',
        detail:
          'Operators register a second Hyland client for configuration access, alongside the one for documents, with the same connection test before saving.',
      },
    ],
  },
  {
    date: '2026-09-03',
    heading: 'Getting unstuck',
    entries: [
      {
        kind: 'added',
        title: 'Force-halt a run that will not respond to Cancel',
        detail:
          "Admin oversight of a run is normally read-only, but a run whose worker has genuinely wedged — not even a container restart frees it — can now be force-halted from the run's admin page. It ends the run immediately and clears its queued work, even while that work still looks like it is being processed.",
      },
      {
        kind: 'fixed',
        title: 'A canceled run no longer shows a step stuck on "Running"',
        detail:
          "If a run's worker crashed mid-step and the run was then canceled before anything ever resumed it, that step could stay marked Running forever even though the run itself had ended. It is now closed out and marked canceled along with the run, so its record shows what actually happened instead of a step frozen in place.",
      },
    ],
  },
  {
    date: '2026-09-02',
    heading: 'Your usage, and agents that learn from their failures',
    entries: [
      {
        kind: 'added',
        title: 'A "My usage" page',
        detail:
          'One place for everything done as you: tokens your agents spend, how many runs they made and how many failed, and every tool call under your account. Pick a window from a week to a year and see the trend for tokens, runs, or tool calls in your own timezone, with a per-agent breakdown and tokens per run.',
      },
      {
        kind: 'added',
        title: 'Every run and every model call is recorded, not just counted',
        detail:
          'Renkei now keeps a timestamped record of each agent run (its outcome, what it cost, and on failure which step it stopped at and why) and of each model call\'s token use, kept for a year by default. "My usage" lists the failures that keep recurring — the same agent stopping at the same step for the same reason — and links you to the fix.',
      },
      {
        kind: 'added',
        title: 'Improve an agent with your org’s model',
        detail:
          'On an agent you own, "Improve" asks the org’s model to read the agent’s recent failures and token spend and report what to change — for accuracy, reliability, and cost. "Draft these fixes" turns the report into a revision the builder offers you to review; nothing changes until you save it.',
      },
    ],
  },
  {
    date: '2026-09-02',
    heading: 'WebEx deep linking and desktop notifications',
    entries: [
      {
        kind: 'added',
        title: 'Click notifications to open WebEx messages and receipts',
        detail:
          'Desktop notifications for WebEx actions now use webexteams:// deep links that open the message or receipt directly in WebEx when clicked.',
      },
      {
        kind: 'fixed',
        title: 'Card headers wrap long titles on narrow screens',
        detail:
          'Agent and organization card headers no longer collapse when titles are long on mobile or narrow viewports.',
      },
    ],
  },
  {
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
    date: '2026-09-02',
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
