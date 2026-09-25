/**
 * What the assistant is doing, said out loud. A voice conversation has no
 * transcript to glance at while a reply is being worked out, and a long
 * tool call or a long think is dead air — the person cannot tell a slow
 * answer from a dropped one. So each tool call is announced as it starts,
 * in words a person uses ("Searching Jira issues"), and a long quiet gets
 * a "still working on it" now and then.
 *
 * Pure: a tool name in, a sentence out. The code tools carry their own
 * running sentence (lib/code/tool-labels.ts); connector tools are
 * `<connector>_<verb>_<noun>`, and the verb is turned into what it is
 * doing ("search" → "Searching"), with the connector named so "Searching
 * issues" and "Searching messages" are not the same sentence.
 */

import { friendlyToolName } from '@renkei/agents';
import { codeToolLabel } from '@/lib/code/tool-labels';

/** How each connector prefix is said. */
const CONNECTORS: Record<string, string> = {
  jira: 'Jira',
  jsm: 'Jira Service Management',
  jsm_ops: 'Jira operations',
  confluence: 'Confluence',
  bitbucket: 'Bitbucket',
  webex: 'WebEx',
  outlook: 'Outlook',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  zoom: 'Zoom',
  mirth: 'Mirth',
  onbase: 'OnBase',
  fileshare: 'the file share',
  sandbox: 'the sandbox',
  asana: 'Asana',
  lucid: 'Lucid',
};

/** Verbs the tools use, as what is happening right now. */
const DOING: Record<string, string> = {
  list: 'Listing',
  get: 'Fetching',
  read: 'Reading',
  search: 'Searching',
  find: 'Finding',
  count: 'Counting',
  browse: 'Browsing',
  download: 'Downloading',
  create: 'Creating',
  add: 'Adding',
  update: 'Updating',
  set: 'Setting',
  delete: 'Deleting',
  remove: 'Removing',
  send: 'Sending',
  reply: 'Replying to',
  forward: 'Forwarding',
  move: 'Moving',
  transition: 'Transitioning',
  bulk: 'Working through',
  log: 'Logging',
  run: 'Running',
  start: 'Starting',
  stop: 'Stopping',
  cancel: 'Cancelling',
  approve: 'Approving',
  merge: 'Merging',
  decline: 'Declining',
  request: 'Requesting',
  share: 'Sharing',
  watch: 'Watching',
  capture: 'Capturing',
  export: 'Exporting',
  import: 'Importing',
  deploy: 'Deploying',
  check: 'Checking',
  analyze: 'Analysing',
  summary: 'Summarising',
  write: 'Writing',
  edit: 'Editing',
  grep: 'Searching',
  ls: 'Listing',
  clone: 'Cloning',
  commit: 'Committing',
  push: 'Pushing',
  pull: 'Pulling',
};

/** Tools said as what they mean rather than parsed: the chat's own, and the code tools. */
const OWN: Record<string, string> = {
  code_grep: 'Searching the code',
  code_find: 'Finding files',
  code_ls: 'Listing a directory',
  code_run: 'Running a command',
  code_read_file: 'Reading a file',
  code_edit_file: 'Editing a file',
  code_write_file: 'Writing a file',
  code_env_names: 'Checking the environment',
  code_delegate: 'Handing a task to a sub-agent',
  chat_delegate: 'Handing a task to a sub-agent',
  code_git_commit: 'Committing',
  code_git_push: 'Pushing',
  code_git_pull: 'Pulling',
  code_git_status: 'Checking git status',
  search_knowledge: 'Searching the knowledge base',
  web_search: 'Searching the web',
  whoami: 'Checking who you are',
  analyze_transcript: 'Reading the transcript',
  daily_summary: 'Pulling together the day',
  sprint_summary: 'Summarising the sprint',
  work_item_summary: 'Summarising the work items',
  log_search: 'Searching the logs',
};

/**
 * "Searching Jira issues", "Cloning the repository", "Reading the
 * transcript": the sentence for a tool that has just been called.
 * Unknown shapes fall back to "Calling <friendly name>", which is at
 * least true.
 */
export function spokenActivity(name: string): string {
  const own = OWN[name];
  if (own) return own;
  const code = codeToolLabel(name);
  if (code?.pending) return code.pending;
  const parts = name.split('_');
  // Jira Service Management's operations tools carry a second prefix.
  if (parts[0] === 'jsm' && parts[1] === 'ops') parts.splice(0, 2, 'jsm_ops');
  const [prefix, verb, ...rest] = parts;
  const connector = prefix ? (CONNECTORS[prefix] ?? undefined) : undefined;
  const doing = verb ? DOING[verb] : undefined;
  if (connector && doing) {
    const noun = rest
      .join(' ')
      .replace(/\bpreview\b|\bconfirm\b/g, '')
      .trim();
    return noun ? `${doing} ${connector} ${noun}` : `${doing} in ${connector}`;
  }
  if (prefix === 'chat' || prefix === 'project' || prefix === 'user') {
    if (name.includes('memory'))
      return name.includes('write') ? 'Saving a memory' : 'Recalling memories';
    if (name.includes('recall')) return 'Recalling earlier chats';
  }
  return `Calling ${friendlyToolName(name, null).toLowerCase()}`;
}

/**
 * The tool as a permission ask names it — "create Jira issue", "open
 * pull request", "save a memory" — what the assistant wants to do, in
 * the infinitive, with the connector named so "create issue" and
 * "create page" are not the same thing.
 */
export function spokenAsk(name: string): string {
  const own = OWN[name];
  if (own) return own.charAt(0).toLowerCase() + own.slice(1).replace(/^(\w+)ing\b/, '$1');
  const code = codeToolLabel(name);
  if (code) return code.label.toLowerCase();
  const parts = name.split('_');
  if (parts[0] === 'jsm' && parts[1] === 'ops') parts.splice(0, 2, 'jsm_ops');
  const [prefix, verb, ...rest] = parts;
  const connector = prefix ? (CONNECTORS[prefix] ?? undefined) : undefined;
  if (connector && verb && DOING[verb]) {
    const noun = rest
      .join(' ')
      .replace(/\bpreview\b|\bconfirm\b/g, '')
      .trim();
    return noun ? `${verb} ${connector} ${noun}` : `${verb} in ${connector}`;
  }
  return friendlyToolName(name, null).toLowerCase();
}
