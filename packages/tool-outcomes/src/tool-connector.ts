/**
 * Which connector a tool belongs to, for display and for telemetry.
 *
 * This returns the CATALOG capability key (`connector-catalog.ts`), not the
 * tool's name prefix. The two differ often enough to matter: `outlook_*` tools
 * belong to the `microsoft` connector, `webex_*` to `webex` (the capability
 * gate calls it `webex-user`), and `jsm_*` sits under `jira`. Splitting a name
 * at its first underscore would produce `outlook`, `webex` and `jsm` — keys no
 * logo, catalog entry or admin toggle recognises, so a usage page built on
 * them would show unlabelled rows and blank icons.
 *
 * One caveat worth stating: for the summary tools this is a DISPLAY grouping,
 * not the gate's. `outlook_calendar_summary` registers behind the Jira
 * capability gate (it is part of the summary orchestrator) but reads as an
 * Outlook tool to a person looking at a list, and that is how it is grouped
 * here. Nothing about access depends on this function.
 */

/** Exact names that carry no connector prefix at all. */
const EXACT: Record<string, string> = {
  whoami: 'jira',
  jira_connect: 'jira',
  analyze_transcript: 'jira',
  search_knowledge: 'knowledge',
  // Cross-connector upload-slot status; grouped with Jira like whoami.
  check_file_upload: 'jira',
  // The orchestrator and the two Jira periods it loops over.
  daily_summary: 'jira',
  sprint_summary: 'jira',
  work_item_summary: 'jira',
};

/** Longest prefix first, so `jsm_ops_` never falls through to a shorter match. */
const PREFIXES: [string, string][] = [
  ['jira_', 'jira'],
  ['jsm_', 'jira'],
  ['confluence_', 'atlassian-confluence'],
  ['bitbucket_', 'atlassian-bitbucket'],
  ['outlook_', 'microsoft'],
  ['sharepoint_', 'sharepoint'],
  ['onedrive_', 'onedrive'],
  ['webex_', 'webex'],
  ['zoom_', 'zoom'],
  ['onbase_', 'onbase'],
  ['knowledge_', 'knowledge'],
  ['fileshare_', 'fileshares'],
  ['card_', 'cards'],
  ['agent_', 'agents'],
  ['log_', 'logs'],
];

/**
 * The catalog capability key for a tool, or null when the name matches nothing
 * known — a new namespace added without updating this map, which the UI shows
 * ungrouped rather than silently dropping.
 */
export function connectorKeyForTool(tool: string): string | null {
  const exact = EXACT[tool];
  if (exact) return exact;
  for (const [prefix, key] of PREFIXES) {
    if (tool.startsWith(prefix)) return key;
  }
  return null;
}
