/**
 * Builds the MCP server both transports expose.
 *
 * The point of this file existing is that stdio and the gateway cannot drift.
 * The tool surface, the annotations, and the instructions a model reads are
 * decided here once; a transport chooses who the caller is and whether writes
 * are allowed, and nothing else.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerJsmTools, registerJsmWriteTools } from '../tools/jsm.js';
import { registerPlaybookTools } from '../tools/playbooks.js';
import { registerReadTools } from '../tools/read.js';
import { registerTranscriptTools } from '../tools/transcript.js';
import { registerWriteTools } from '../tools/write.js';
import type { ToolContext } from '../tools/common.js';

export const SERVER_NAME = 'renkei';
export const SERVER_VERSION = '0.1.0';

export const INSTRUCTIONS = [
  'Renkei proxies access to a single Atlassian Jira Cloud site, covering both work items',
  'and Jira Service Management customer requests.',
  '',
  'If a tool returns an authentication error, re-run `pnpm auth` to refresh credentials,',
  'then retry. If connection is lost (e.g. after server restart), calls will fail with',
  'network errors — try whoami first to verify the connection is live.',
  '',
  'Work items: search_issues with JQL to find them, get_issue for the full text of one.',
  'Service management: list_service_desks, then list_request_types, then get_request.',
  'Sprints and boards: when looking for sprints, start with list_boards to find board IDs,',
  'then use list_sprints for a specific board. Boards organize sprints in Jira Software.',
  '',
  'Before transitioning anything, list the transitions for that specific item — IDs are',
  'workflow-specific and differ between the platform and the portal, so an ID from',
  'list_transitions will not work with transition_request or vice versa.',
  '',
  'Comments on customer requests default to internal. Only pass public: true when the text',
  'is written for the customer, because a public comment normally emails them immediately.',
  'The same applies to attachments on a request.',
  '',
  'SLA times from get_request_sla are working time on the project calendar, and the clock can',
  'be paused, so a remaining duration is not a countdown from now. When stating a deadline or',
  'whether something is about to breach, quote the breach timestamp, not the remaining time.',
  '',
  'Files can be attached but not read back. Pass the bytes base64-encoded in contentBase64;',
  'there is no path argument, because a path would resolve on the server rather than for the',
  'user. Existing attachments cannot be downloaded through any tool here.',
  '',
  'Only standard fields are returned; custom fields and attachment contents are not available',
  'and cannot be requested. If a call is refused, the endpoint is outside the allowlist —',
  'that is a deliberate policy decision, not a transient error, so do not retry it.',
].join('\n');

export interface McpServerOptions {
  context: ToolContext;
  /**
   * When false the mutating tools are never registered, so they are absent
   * from tools/list rather than present and refusing. A model cannot be talked
   * into calling a tool it cannot see.
   *
   * Two things can set this: READ_ONLY for the whole deployment, or a session
   * that was only granted `jira:read`.
   */
  allowWrites: boolean;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerReadTools(server, options.context);
  registerTranscriptTools(server, options.context);
  registerJsmTools(server, options.context);
  registerPlaybookTools(server, options.context);

  if (options.allowWrites) {
    registerWriteTools(server, options.context);
    registerJsmWriteTools(server, options.context);
  }

  return server;
}
