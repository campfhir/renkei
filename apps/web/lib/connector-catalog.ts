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
 *                 `disabledConnectors`, a person's catalog selections and an
 *                 admin's audience rules all name. Finer-grained than
 *                 configKey, which is the whole point: SharePoint can be
 *                 switched off without touching mail.
 *   grantProviders the `provider_grants.provider` values a person's connection
 *                 is stored under, where one exists.
 *
 * Pure data with no imports beyond types, so client components can use it.
 * Component bindings (which admin form configures a connector) live in
 * `lib/connectors/definitions.tsx`, which imports this — never the reverse.
 */

/** How the catalog groups entries, for a person scanning rather than searching. */
export type ConnectorCategory =
  'atlassian' | 'microsoft' | 'communications' | 'documents' | 'files' | 'search' | 'renkei';

export const CONNECTOR_CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  atlassian: 'Atlassian',
  microsoft: 'Microsoft 365',
  communications: 'Meetings and messaging',
  documents: 'Document management',
  files: 'Files',
  search: 'Search and knowledge',
  renkei: 'Renkei',
};

/** The composite card on the connectors page that hosts a product's panel. */
export type ConnectorSuite = 'atlassian' | 'microsoft' | 'hyland';

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
  category: ConnectorCategory;
  /**
   * Search synonyms — what a person types when they do not know the product
   * name ("email", "tickets", "wiki"). Matched alongside label and summary.
   */
  keywords: string[];
  /** Which composite card renders this product's panel, if any. */
  suite?: ConnectorSuite;
  /**
   * The provider_grants.provider values that mean "this person connected
   * it". Empty for connectors without a per-user grant (file shares hold
   * per-share connections; Renkei's own surfaces need none).
   */
  grantProviders: string[];
  /**
   * Whether a person adds and connects this themselves on the connectors
   * page. False for Renkei's own surfaces (cards, agents, logs, memory,
   * knowledge, web search, the sandbox, batch jobs) — they are provisioned
   * org-wide or exist for every caller, so offering them in a personal
   * catalog would be a choice with nothing behind it.
   */
  userConnectable: boolean;
  /**
   * Whether the org-wide off switch applies. False only for entries that
   * register no tools (Mistral OCR is a pipeline stage, not a tool family):
   * offering a switch there would promise a control that does nothing.
   */
  togglable: boolean;
}

export const CONNECTOR_CATALOG: ConnectorEntry[] = [
  {
    capabilityKey: 'jira',
    configKey: 'atlassian',
    label: 'Jira',
    summary: 'Issues, boards, sprints, worklogs and filters.',
    toolPrefix: 'jira_*',
    category: 'atlassian',
    keywords: ['issues', 'tickets', 'boards', 'sprints', 'backlog', 'worklog', 'jql'],
    suite: 'atlassian',
    grantProviders: ['atlassian'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'jira',
    configKey: 'atlassian-jsm',
    label: 'Jira Service Management',
    summary: 'Service desk requests, approvals and on-call operations.',
    toolPrefix: 'jsm_*',
    category: 'atlassian',
    keywords: ['jsm', 'service desk', 'requests', 'on-call', 'alerts', 'incidents', 'helpdesk'],
    suite: 'atlassian',
    grantProviders: ['atlassian-jsm'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'atlassian-confluence',
    configKey: 'atlassian-confluence',
    label: 'Confluence',
    summary: 'Pages, blogposts, spaces, comments and attachments.',
    toolPrefix: 'confluence_*',
    category: 'atlassian',
    keywords: ['wiki', 'pages', 'spaces', 'documentation', 'docs', 'blog'],
    suite: 'atlassian',
    grantProviders: ['atlassian-confluence'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'atlassian-bitbucket',
    configKey: 'atlassian-bitbucket',
    label: 'Bitbucket',
    summary: 'Repositories, branches, commits, pull requests and pipelines.',
    toolPrefix: 'bitbucket_*',
    category: 'atlassian',
    keywords: ['git', 'repos', 'repositories', 'pull requests', 'pr', 'code', 'pipelines', 'ci'],
    suite: 'atlassian',
    grantProviders: ['atlassian-bitbucket'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'microsoft',
    configKey: 'microsoft',
    label: 'Outlook',
    summary: 'Mail, calendar and Microsoft To Do.',
    toolPrefix: 'outlook_*',
    category: 'microsoft',
    keywords: ['email', 'mail', 'calendar', 'meetings', 'tasks', 'to do', 'inbox', 'office 365'],
    suite: 'microsoft',
    grantProviders: ['microsoft'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'sharepoint',
    configKey: 'microsoft',
    label: 'SharePoint',
    summary: 'Sites, pages, document libraries and their metadata.',
    toolPrefix: 'sharepoint_*',
    category: 'microsoft',
    keywords: ['sites', 'document library', 'intranet', 'files', 'teams files'],
    suite: 'microsoft',
    grantProviders: ['microsoft'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'onedrive',
    configKey: 'microsoft',
    label: 'OneDrive',
    summary: 'Personal files, folders and sharing.',
    toolPrefix: 'onedrive_*',
    category: 'microsoft',
    keywords: ['files', 'drive', 'documents', 'sharing', 'my files'],
    suite: 'microsoft',
    grantProviders: ['microsoft'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'webex',
    configKey: 'webex-user',
    label: 'WebEx',
    summary: 'Spaces, messages, meetings, recordings and transcripts.',
    toolPrefix: 'webex_*',
    category: 'communications',
    keywords: [
      'chat',
      'messages',
      'spaces',
      'rooms',
      'meetings',
      'recordings',
      'transcripts',
      'cisco',
    ],
    grantProviders: ['webex'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'zoom',
    configKey: 'zoom',
    label: 'Zoom',
    summary: 'Meetings, recordings, transcripts and notes.',
    toolPrefix: 'zoom_*',
    category: 'communications',
    keywords: ['meetings', 'video', 'recordings', 'transcripts', 'notes', 'calls'],
    grantProviders: ['zoom'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'onbase',
    configKey: 'onbase',
    label: 'OnBase',
    summary: "Documents, keywords and custom queries on your organization's Hyland OnBase.",
    toolPrefix: 'onbase_*',
    category: 'documents',
    keywords: ['hyland', 'documents', 'records', 'keywords', 'archive', 'ecm', 'scanning'],
    suite: 'hyland',
    grantProviders: ['onbase'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'onbase-admin',
    configKey: 'onbase-admin',
    label: 'OnBase Administration',
    summary:
      'Create and configure document types, keyword types, keyword assignments and their ' +
      "groups on your organization's Hyland OnBase; look up users and user groups and grant " +
      'document types to them. A separate connection from OnBase above (its own Hyland OAuth ' +
      'client) — connecting one does not connect the other.',
    toolPrefix: 'onbase_admin_*',
    category: 'documents',
    keywords: ['hyland', 'document types', 'keyword types', 'user groups', 'configuration'],
    suite: 'hyland',
    grantProviders: ['onbase-admin'],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'fileshares',
    // No connector_configs row: shares are many-per-tenant rows in
    // file_shares, and each person connects with their own credentials —
    // the key exists so the identifier stays consistent.
    configKey: 'fileshares',
    label: 'File shares',
    summary: 'Org SMB and SFTP network shares — everyone connects with their own credentials.',
    toolPrefix: 'fileshare_*',
    category: 'files',
    keywords: ['smb', 'sftp', 'network drive', 'shared drive', 'nas', 'folders', 'files'],
    grantProviders: [],
    userConnectable: true,
    togglable: true,
  },
  {
    capabilityKey: 'cards',
    // No connector_configs row: cards are Renkei's own feed and need no
    // credentials — the key exists so the identifier stays consistent.
    configKey: 'cards',
    label: 'Renkei cards',
    summary: 'Informational cards users and agents put on the Renkei feed.',
    toolPrefix: 'card_*',
    category: 'renkei',
    keywords: ['feed', 'briefing', 'home'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'agents',
    // No connector_configs row: agents live entirely in Renkei's own
    // store — the key exists so the identifier stays consistent.
    configKey: 'agents',
    label: 'Renkei agents',
    summary: 'Read, draft and update your own agents — definitions, runs, knowledge, memory.',
    toolPrefix: 'agent_*',
    category: 'renkei',
    keywords: ['automation', 'runs', 'workflows'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'batch-jobs',
    // No connector_configs row: batch_jobs is a plain Renkei table — the key
    // exists so the identifier stays consistent.
    configKey: 'batch-jobs',
    label: 'Renkei batch jobs',
    summary: 'Start and follow long-running document pipelines over many files at once.',
    toolPrefix: 'batch_*',
    category: 'renkei',
    keywords: ['pipeline', 'ocr', 'bulk', 'jobs'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'logs',
    // No connector_configs row: this reads Renkei's own log store — the key
    // exists so the identifier stays consistent.
    configKey: 'logs',
    label: 'Renkei logs',
    summary:
      "Your own activity in Renkei's log, self-scoped the same way the web Logs page scopes a non-admin.",
    toolPrefix: 'log_*',
    category: 'renkei',
    keywords: ['activity', 'audit', 'history'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'user-memory',
    // No connector_configs row: this reads chat_user_memories, Renkei's own
    // table — the key exists so the identifier stays consistent.
    configKey: 'user-memory',
    label: 'Renkei memory',
    summary:
      "Read-only view of a person's own memory, carried across every chat they own — an " +
      'agent may see it, never add to or remove from it.',
    toolPrefix: 'user_memory_*',
    category: 'renkei',
    keywords: ['memory', 'preferences', 'remember'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'sandbox',
    // No connector_configs row: the scratch space is Renkei's own worker,
    // scoped to the caller — the key exists so the identifier stays
    // consistent. Browser secrets are managed on the connectors page, but
    // that card is not a connection and the sandbox is not something a
    // person adds.
    configKey: 'sandbox',
    label: 'Renkei sandbox',
    summary:
      'A per-person scratch space for staging files between connectors, with an isolated ' +
      'headless browser where the deployment enables it.',
    toolPrefix: 'sandbox_*',
    category: 'renkei',
    keywords: ['scratch', 'files', 'browser', 'staging', 'download', 'upload'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'knowledge',
    configKey: 'embeddings',
    label: 'Knowledge',
    summary:
      'Semantic search over everything indexed, access-checked per reader — plus personal notes.',
    toolPrefix: 'search_knowledge, knowledge_*',
    category: 'search',
    keywords: ['search', 'embeddings', 'index', 'notes', 'semantic'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'web-search',
    configKey: 'web-search',
    label: 'Web search',
    summary:
      "Public-web search with citations through the org's Azure OpenAI deployment and its " +
      'built-in web_search tool (Grounding with Bing). One org-wide endpoint and key.',
    toolPrefix: 'web_search',
    category: 'search',
    keywords: ['internet', 'bing', 'google', 'public web', 'citations'],
    grantProviders: [],
    userConnectable: false,
    togglable: true,
  },
  {
    capabilityKey: 'mistral-ocr',
    configKey: 'mistral-ocr',
    label: 'Mistral OCR',
    summary:
      'Document text extraction (Mistral Document AI on Microsoft Foundry) used by the ' +
      'document pipeline and sandbox_ocr_file. One org-wide endpoint and key; registers no ' +
      'tools of its own.',
    toolPrefix: '(pipeline stage)',
    category: 'documents',
    keywords: ['ocr', 'scan', 'pdf', 'text extraction', 'document ai', 'foundry'],
    grantProviders: [],
    userConnectable: false,
    togglable: false,
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
    if (!entry.togglable) return false;
    if (seen.has(entry.capabilityKey)) return false;
    seen.add(entry.capabilityKey);
    return true;
  });
}

/** The entries a person can add to their own catalog and connect. */
export function userConnectableConnectors(): ConnectorEntry[] {
  return CONNECTOR_CATALOG.filter((entry) => entry.userConnectable);
}

/** The catalog entry for a capability key — the first, where Jira and JSM share one. */
export function connectorEntryFor(capabilityKey: string): ConnectorEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === capabilityKey);
}
