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
