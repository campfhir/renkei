/**
 * Preferences' sections, with no React: what the sidebar lists and in
 * which groups, which section a path is, and whether a path is the
 * section list itself. preferences-nav.tsx renders from this — the sidebar
 * beside the section on a wide screen, the list as the page on a phone —
 * and the overview page (page.tsx) lists the same sections with what each
 * holds now. Tested in preferences-nav.model.test.ts.
 *
 * Every section is its own page under /preferences, so it can be linked
 * to: an agent's settings point at Agents, a chat's permission card at
 * Tool permissions, the notifications page at Notifications.
 */

export const PREFERENCES_PATH = '/preferences';

export type PreferencesSectionId =
  | 'appearance'
  | 'voice'
  | 'models'
  | 'chats'
  | 'permissions'
  | 'agents'
  | 'code'
  | 'notifications'
  | 'security'
  | 'data';

/** The icon each section shows: names in components/icons.tsx's ICONS. */
export type PreferencesIcon =
  | 'sun'
  | 'microphone'
  | 'sparkles'
  | 'chat'
  | 'shield'
  | 'agent'
  | 'code'
  | 'bell'
  | 'lock'
  | 'download';

export interface PreferencesSection {
  id: PreferencesSectionId;
  label: string;
  icon: PreferencesIcon;
  /** What the section holds, for the overview when there is no state to say. */
  blurb: string;
}

export interface PreferencesGroup {
  label: string;
  sections: PreferencesSection[];
}

export const PREFERENCES_GROUPS: readonly PreferencesGroup[] = [
  {
    label: 'General',
    sections: [
      { id: 'appearance', label: 'Appearance', icon: 'sun', blurb: 'Theme and code blocks' },
      { id: 'voice', label: 'Voice', icon: 'microphone', blurb: 'The voice that reads replies' },
      { id: 'models', label: 'Models', icon: 'sparkles', blurb: 'Chat and image models' },
      { id: 'chats', label: 'Chats', icon: 'chat', blurb: 'Archiving and default tools' },
    ],
  },
  {
    label: 'Tools & automation',
    sections: [
      {
        id: 'permissions',
        label: 'Tool permissions',
        icon: 'shield',
        blurb: 'What a chat may do without asking',
      },
      { id: 'agents', label: 'Agents', icon: 'agent', blurb: 'What still waits for you' },
      {
        id: 'code',
        label: 'Code projects',
        icon: 'code',
        blurb: 'Default tools and Auto mode',
      },
    ],
  },
  {
    label: 'Notifications',
    sections: [
      {
        id: 'notifications',
        label: 'Notifications',
        icon: 'bell',
        blurb: 'What reaches you, and where',
      },
    ],
  },
  {
    label: 'Account',
    sections: [
      { id: 'security', label: 'Security', icon: 'lock', blurb: 'Your encryption key' },
      { id: 'data', label: 'Your data', icon: 'download', blurb: 'Export or import' },
    ],
  },
];

export const PREFERENCES_SECTIONS: readonly PreferencesSection[] = PREFERENCES_GROUPS.flatMap(
  (group) => group.sections
);

/** A section's page. */
export function sectionHref(id: PreferencesSectionId): string {
  return `${PREFERENCES_PATH}/${id}`;
}

/**
 * The section a path is in (`/preferences/agents`, or anything under it),
 * or null for the section list and for any path outside Preferences.
 */
export function currentSection(pathname: string): PreferencesSectionId | null {
  const rest = pathname.replace(/\/+$/, '');
  if (!rest.startsWith(`${PREFERENCES_PATH}/`)) return null;
  const first = rest.slice(PREFERENCES_PATH.length + 1).split('/')[0];
  return PREFERENCES_SECTIONS.find((section) => section.id === first)?.id ?? null;
}

/** Whether the path is the section list itself (`/preferences`). */
export function isSectionList(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === PREFERENCES_PATH;
}

/**
 * The cards the Notifications section holds, in page order, for the
 * sidebar's sub-list on a wide screen and the chips on a phone. Each id is
 * the card's element id (preferences-form.tsx), so a link scrolls to it.
 */
export const NOTIFICATION_CARDS: readonly { id: string; label: string }[] = [
  { id: 'notify-runs', label: 'Runs' },
  { id: 'notify-batch-jobs', label: 'Batch jobs' },
  { id: 'notify-deployments', label: 'Deployments' },
  { id: 'notify-sharing', label: 'Sharing' },
  { id: 'notify-approvals', label: 'Approvals & questions' },
  { id: 'notify-overrides', label: 'Agent overrides' },
  { id: 'notify-acts', label: 'Things your agents do' },
  { id: 'notify-popups', label: 'Pop-ups' },
  { id: 'notify-browser', label: 'Browser notifications' },
];

/** What the overview reads to say where each section stands. */
export interface SectionState {
  theme: { mode: 'auto' | 'light' | 'dark'; codeLineNumbers: boolean };
  archiveAfterDays: number | null;
  permissions: { allowed: number; blocked: number };
  /** High-risk tools for agents: the organization's locked ones and the person's own marks. */
  agentHighRisk: number;
  /** Tools the person moved on or off the code projects' default list. */
  codeChanges: number;
}

/** One line per section for the overview; a section with no state to say gets its blurb. */
export function sectionSummaries(state: SectionState): Record<PreferencesSectionId, string> {
  const blurb = (id: PreferencesSectionId) =>
    PREFERENCES_SECTIONS.find((section) => section.id === id)?.blurb ?? '';
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const theme = { auto: 'Matches your system', light: 'Light', dark: 'Dark' }[state.theme.mode];
  const { allowed, blocked } = state.permissions;
  return {
    voice: blurb('voice'),
    models: blurb('models'),
    notifications: blurb('notifications'),
    security: blurb('security'),
    data: blurb('data'),
    appearance: `${theme}${state.theme.codeLineNumbers ? ' · line numbers on' : ''}`,
    chats:
      state.archiveAfterDays === null
        ? 'Never archived automatically'
        : `Archived after ${plural(state.archiveAfterDays, 'day')} unused`,
    permissions:
      allowed === 0 && blocked === 0
        ? 'Everything that acts asks first'
        : [allowed > 0 ? `${allowed} allowed` : null, blocked > 0 ? `${blocked} blocked` : null]
            .filter((part) => part !== null)
            .join(', '),
    agents:
      state.agentHighRisk === 0
        ? 'Nothing waits when an agent accepts its own actions'
        : `${plural(state.agentHighRisk, 'high-risk tool')} still ${state.agentHighRisk === 1 ? 'waits' : 'wait'} for you`,
    code:
      state.codeChanges === 0
        ? 'Auto mode asks before anything outside the checkout'
        : `Auto mode: ${plural(state.codeChanges, 'tool')} changed from the default`,
  };
}
