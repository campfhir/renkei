/**
 * The contract between a tour and the markup it points at.
 *
 * A step names an anchor; an element carries it as `data-coach="<anchor>"`
 * (through `coachAnchor()`, so a typo is a type error). The list is closed
 * on purpose: `tours.test.ts` checks every step's target against it, so
 * renaming or removing an anchor breaks at unit-test time rather than as a
 * step that quietly stops pointing at anything. Add an anchor here first,
 * then to the element, then to a tour.
 *
 * Names say where the element lives (`nav-`, `chat-`…) and what it is,
 * never how it looks — a button that becomes a link keeps its anchor.
 */
export const COACH_ANCHORS = [
  /** The hamburger in the top bar. */
  'nav-menu-button',
  /** The Workspace group in the menu column. */
  'nav-workspace',
  /** The Chat group in the menu column. */
  'nav-chat',
  /** The avatar button that opens the account menu. */
  'nav-account',
  /** The Tutorials item inside the account menu. */
  'account-tutorials',
  /** The actionable-items heading block on the home page. */
  'home-feed',
  /** The New agent button on the Agents page. */
  'agents-new',
  /** The Import button beside it. */
  'agents-import',
  /** The list of agents. */
  'agents-list',
  /** The chat's message box. */
  'chat-composer',
  /** The Tools button in the composer. */
  'chat-tools',
  /** The model picker in the composer. */
  'chat-model',
  /** The Send button. */
  'chat-send',
  /** The Add connector button on the Connectors page. */
  'connectors-add',
  /** The MCP endpoint block on the Connectors page. */
  'connectors-endpoint',
  /** The Organization page's grid of console areas. */
  'admin-sections',

  // The agent builder (agents/new, agents/[id]/edit).
  /** The name field. */
  'builder-name',
  /** The flow canvas the steps are drawn on. */
  'builder-canvas',
  /** A "+" between nodes — add a step, branch, loop or group there. */
  'builder-add',
  /** The "Add a trigger" control in the trigger node. */
  'builder-triggers',
  /** The Save / Update button (rendered for the phone and the desktop alike). */
  'builder-save',

  // An agent's own page and its runs.
  /** The Edit link in the header. */
  'agent-edit',
  /** The Share button (the owner's). */
  'agent-share',
  /** Run now, beside the schedule. */
  'agent-run-now',
  /** The Runs card in the rail: the triggers, and the way to the history. */
  'agent-runs-card',
  /** The status pills on the runs list. */
  'runs-filters',
  /** The search box on the runs list. */
  'runs-search',

  // Knowledge and Files.
  /** The knowledge search box and its button. */
  'knowledge-search',
  /** The source pills under the box. */
  'knowledge-sources',
  /** The files browser: the shares list, or the folder view once one is open. */
  'files-browser',
  /** The folder view's toolbar: filter, folders first, new folder, upload. */
  'files-toolbar',

  // The chat thread beyond the composer's basics.
  /** Attach a file (only when the org has storage). */
  'chat-attach',
  /** Insert a prompt from a library. */
  'chat-prompt',
  /** Dictate into the box (only when the org has a voice service). */
  'chat-voice',
  /** The title bar's overflow menu: share, rename, archive, delete. */
  'chat-more',
  /** The card a turn shows while it waits for permission to use a tool. */
  'chat-permission-card',

  // Projects, prompt libraries, memory, code.
  /** New project, on the projects index. */
  'projects-new',
  /** A project's chats section. */
  'project-chats',
  /** A project's About section: name, description, instructions. */
  'project-about',
  /** A project's files section. */
  'project-files',
  /** A project's memory section. */
  'project-memory',
  /** New library, on the prompt libraries index. */
  'prompts-new',
  /** A library's Share button (the owner's). */
  'library-share',
  /** A library's New prompt button (for someone who may edit it). */
  'library-new-prompt',
  /** The box that adds a memory note. */
  'memory-add',
  /** New code project, on the Code index. */
  'code-new',
  /** The repository search on the new code project form. */
  'code-repo-search',
  /** The standing instructions on the new code project form. */
  'code-instructions',

  // The pages behind the avatar.
  /** The "Choose what appears here" link on the notifications page. */
  'notifications-preferences-link',
  /** Mark all as read (only while something is unread). */
  'notifications-mark-all',
  /** The Appearance card on Preferences. */
  'prefs-appearance',
  /** The Voice card (only when the org has a voice service). */
  'prefs-voice',
  /** The default-tools cards (one for chats, one for code projects). */
  'prefs-default-tools',
  /** The "What a chat may do" card. */
  'prefs-permissions',
  /** The notifications grid. */
  'prefs-notifications',
  /** New batch job. */
  'batch-jobs-new',
  /** Schedules, beside it. */
  'batch-jobs-schedules',
  /** The period pills on the Tools page. */
  'usage-period',
  /** The stat tiles on the Tools page. */
  'usage-stats',
  /** The period pills on My usage. */
  'utilization-period',
  /** The stat tiles on My usage. */
  'utilization-stats',
  /** The level filter on Activity. */
  'logs-levels',
  /** The search bar on Activity. */
  'logs-search',
  /** The changelog heading on About. */
  'about-changelog',
  /** The auto-start switch card on Tutorials. */
  'tutorials-switch',

  // The Connectors page: the add-connector modal and each product's card.
  // A card anchor sits on the whole card (or the product's panel inside a
  // suite card); the others on the controls inside it that a first
  // connection goes through. A control only there before connecting (the
  // capability picker, the Connect button) is absent once connected, and
  // its step then shows centred.
  /** The search box in the Add a connector modal. */
  'connectors-search',
  /** The catalog rows in the modal, each with its Add. */
  'connectors-catalog',
  /** The Jira panel of the Atlassian card. */
  'card-jira',
  /** Jira's "What Renkei may do" picker (or the authorized list, once connected). */
  'jira-scopes',
  /** Connect Jira. */
  'jira-connect',
  /** The Service Management panel. */
  'card-jsm',
  /** Its capability picker. */
  'jsm-scopes',
  /** Connect Service Management. */
  'jsm-connect',
  /** The Confluence panel. */
  'card-confluence',
  /** Its capability picker. */
  'confluence-scopes',
  /** Connect Confluence. */
  'confluence-connect',
  /** The Jira Administration panel. */
  'card-jira-admin',
  /** Its capability picker. */
  'jira-admin-scopes',
  /** Connect Jira Administration. */
  'jira-admin-connect',
  /** The Bitbucket panel. */
  'card-bitbucket',
  /** Its capability picker. */
  'bitbucket-scopes',
  /** Connect Bitbucket. */
  'bitbucket-connect',
  /** The GitHub card. */
  'card-github',
  /** Its capability picker. */
  'github-scopes',
  /** Connect GitHub. */
  'github-connect',
  /** The Microsoft 365 card. */
  'card-microsoft',
  /** The product panels inside it (Outlook, SharePoint, OneDrive…), each with its capabilities. */
  'microsoft-products',
  /** Connect Microsoft 365 (or Re-authorize, once connected). */
  'microsoft-connect',
  /** Outlook's "What gets indexed" checkboxes (only once connected). */
  'outlook-indexing',
  /** The WebEx card. */
  'card-webex',
  /** Its capability picker. */
  'webex-scopes',
  /** Connect WebEx. */
  'webex-connect',
  /** The "Watch all my spaces" switch (only once connected). */
  'webex-watch-spaces',
  /** The Zoom card. */
  'card-zoom',
  /** Its capability picker. */
  'zoom-scopes',
  /** Connect Zoom. */
  'zoom-connect',
  /** The OnBase panel of the Hyland card. */
  'card-onbase',
  /** Connect OnBase. */
  'onbase-connect',
  /** The OnBase Administration panel. */
  'card-onbase-admin',
  /** Connect OnBase Administration. */
  'onbase-admin-connect',
  /** The File shares card. */
  'card-fileshares',
  /** Its list of shares, each with Connect or its connection. */
  'fileshares-list',
  /** The Mirth Connect card. */
  'card-mirth',
  /** Its list of instances, each with Connect or its connection. */
  'mirth-list',
  /** The ADManager Plus card. */
  'card-admanager',
  /** Its list of instances, each with Connect or its connection. */
  'admanager-list',
  /** The Browser secrets card. */
  'card-secrets',
  /** Add secret. */
  'secrets-add',

  // The organization console (operators). One tour per area; each area's
  // first anchor is what its tour requires.
  /** Connector setup: the Find a connector box. */
  'admin-connectors-search',
  /** Connector setup: the rows, grouped by category. */
  'admin-connectors-list',
  /** A connector's page: its registration form (or the note that it needs none). */
  'admin-connector-form',
  /** A connector's page: the Offered to everyone switches. */
  'admin-connector-availability',
  /** A connector's page: an audience control (which groups it is offered to). */
  'admin-connector-audience',
  /** File shares: the list of registered shares (or its empty note). */
  'admin-shares-list',
  /** File shares: + New share. */
  'admin-shares-new',
  /** Mirth Connect: the list of registered instances (or its empty note). */
  'admin-mirth-list',
  /** Mirth Connect: + New instance. */
  'admin-mirth-new',
  /** ADManager Plus: the list of registered instances (or its empty note). */
  'admin-admanager-list',
  /** ADManager Plus: + New instance. */
  'admin-admanager-new',
  /** Sites: the Atlassian sites block. */
  'admin-sites-atlassian',
  /** Sites: the Indexed for knowledge search block. */
  'admin-sites-indexed',
  /** Agent models: the list of models. */
  'admin-models-list',
  /** Agent models: + Add a model. */
  'admin-models-add',
  /** Storage: the Azure Blob Storage form. */
  'admin-storage-form',
  /** Agent oversight: the period toggle and sort. */
  'admin-oversight-controls',
  /** Agent oversight: the organization-wide totals card. */
  'admin-oversight-org',
  /** Agent oversight: the run history retention form. */
  'admin-oversight-retention',
  /** Holiday calendars: the list of calendars (or its empty note). */
  'admin-calendars-list',
  /** Holiday calendars: + New calendar. */
  'admin-calendars-new',
  /** Organization usage: the period pills. */
  'admin-usage-period',
  /** Organization usage: the Person picker. */
  'admin-usage-person',
  /** Sensitive data: the Filter tool results master switch. */
  'admin-redaction-master',
  /** Sensitive data: the What to look for detectors. */
  'admin-redaction-detectors',
  /** Email sanitizer: the Classifier rules card. */
  'admin-sanitizer-rules',
  /** Email sanitizer: the Cleaner scripts card. */
  'admin-sanitizer-scripts',
  /** Settings: the Safety section (read-only mode, guided tours). */
  'admin-settings-safety',
  /** Settings: Save settings. */
  'admin-settings-save',
  /** Settings: the Identity section (sign-in, role and groups claims). */
  'admin-settings-identity',
  /** Access: the people-and-connectors table (or its empty note). */
  'admin-access-table',
  /** Audit: the day-by-day list (or its empty note). */
  'admin-audit-list',
  /** Events: the list (or its empty note). */
  'admin-events-list',
  /** Events: the status pills above the table. */
  'admin-events-filters',
  /** Tutorials report: the By tour table. */
  'admin-tutorials-tours',
  /** Tutorials report: the By person table (or its empty note). */
  'admin-tutorials-people',
] as const;

export type CoachAnchor = (typeof COACH_ANCHORS)[number];

export function isCoachAnchor(value: unknown): value is CoachAnchor {
  return typeof value === 'string' && COACH_ANCHORS.some((anchor) => anchor === value);
}

/** The attribute an element spreads to become a step's target. */
export function coachAnchor(name: CoachAnchor): { 'data-coach': CoachAnchor } {
  return { 'data-coach': name };
}

/** The selector the engine looks the anchor up with. */
export function coachSelector(name: CoachAnchor): string {
  return `[data-coach="${name}"]`;
}
