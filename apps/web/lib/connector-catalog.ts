/**
 * The connectors as a person thinks of them — one entry per thing that shows
 * up in the UI, in the order it should be listed.
 *
 * There are three different "connector" identifiers in this codebase and
 * conflating them causes real bugs, so this is where they are reconciled:
 *
 *   configKey     the `connector_configs` row an admin fills in (credentials,
 *                 scope ceiling). Several products share one — SharePoint,
 *                 OneDrive and Outlook all ride the single 'microsoft' app.
 *   capabilityKey what the capability registry gates tools on, and what
 *                 `disabledConnectors` names. Finer-grained than configKey,
 *                 which is the whole point: SharePoint can be switched off
 *                 without touching mail.
 *   grantProvider the `provider_grants.provider` a user's connection is
 *                 stored under, where one exists.
 *
 * Pure data with no imports beyond types, so client components can use it.
 */

export interface ConnectorEntry {
  /** Capability-registry key — what disabledConnectors switches. */
  capabilityKey: string;
  /** The connector_configs row it needs, when it needs one. */
  configKey: string;
  label: string;
  /** One line an admin can decide from. */
  summary: string;
  /** Tool name prefix, so the admin page can say what disappears. */
  toolPrefix: string;
}

export const CONNECTOR_CATALOG: ConnectorEntry[] = [
  {
    capabilityKey: 'jira',
    configKey: 'atlassian',
    label: 'Jira',
    summary: 'Issues, boards, sprints, worklogs and filters.',
    toolPrefix: 'jira_*',
  },
  {
    capabilityKey: 'jira',
    configKey: 'atlassian-jsm',
    label: 'Jira Service Management',
    summary: 'Service desk requests, approvals and on-call operations.',
    toolPrefix: 'jsm_*',
  },
  {
    capabilityKey: 'atlassian-confluence',
    configKey: 'atlassian-confluence',
    label: 'Confluence',
    summary: 'Pages, blogposts, spaces, comments and attachments.',
    toolPrefix: 'confluence_*',
  },
  {
    capabilityKey: 'microsoft',
    configKey: 'microsoft',
    label: 'Outlook',
    summary: 'Mail, calendar and Microsoft To Do.',
    toolPrefix: 'outlook_*',
  },
  {
    capabilityKey: 'sharepoint',
    configKey: 'microsoft',
    label: 'SharePoint',
    summary: 'Sites, pages, document libraries and their metadata.',
    toolPrefix: 'sharepoint_*',
  },
  {
    capabilityKey: 'onedrive',
    configKey: 'microsoft',
    label: 'OneDrive',
    summary: 'Personal files, folders and sharing.',
    toolPrefix: 'onedrive_*',
  },
  {
    capabilityKey: 'webex',
    configKey: 'webex-user',
    label: 'WebEx',
    summary: 'Spaces, messages, meetings, recordings and transcripts.',
    toolPrefix: 'webex_*',
  },
  {
    capabilityKey: 'zoom',
    configKey: 'zoom',
    label: 'Zoom',
    summary: 'Meetings, recordings, transcripts and notes.',
    toolPrefix: 'zoom_*',
  },
  {
    capabilityKey: 'cards',
    // No connector_configs row: cards are Renkei's own feed and need no
    // credentials — the key exists so the identifier stays consistent.
    configKey: 'cards',
    label: 'Renkei cards',
    summary: 'Informational cards users and agents put on the Renkei feed.',
    toolPrefix: 'card_*',
  },
  {
    capabilityKey: 'agents',
    // No connector_configs row: agents live entirely in Renkei's own
    // store — the key exists so the identifier stays consistent.
    configKey: 'agents',
    label: 'Renkei agents',
    summary: 'Read, draft and update your own agents — definitions, runs, knowledge, memory.',
    toolPrefix: 'agent_*',
  },
  {
    capabilityKey: 'knowledge',
    configKey: 'embeddings',
    label: 'Knowledge',
    summary:
      'Semantic search over everything indexed, access-checked per reader — plus personal notes.',
    toolPrefix: 'search_knowledge, knowledge_*',
  },
];

/**
 * What an admin can switch off, deduplicated by capability key.
 *
 * Jira and JSM share the 'jira' capability key, so they are one switch — and
 * that is honest rather than a shortcut: the registry cannot separate them,
 * so offering two toggles would imply a control that does not exist.
 */
export function togglableConnectors(): ConnectorEntry[] {
  const seen = new Set<string>();
  return CONNECTOR_CATALOG.filter((entry) => {
    if (seen.has(entry.capabilityKey)) return false;
    seen.add(entry.capabilityKey);
    return true;
  });
}
