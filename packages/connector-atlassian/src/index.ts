/**
 * @renkei/connector-atlassian — the Atlassian pieces shared between the
 * worker (content polling) and the web app (ACL verification).
 *
 * The full Jira/JSM/Confluence MCP tool surfaces deliberately stay in
 * `apps/web/lib/mcp-tools/`; only what BOTH processes need lives here,
 * because the worker cannot import from the Next app.
 */

export {
  atlassianFetch,
  listOf,
  rec,
  str,
  ATLASSIAN_GATEWAY,
  type AtlassianCall,
  type AtlassianProduct,
  type AtlassianResponse,
} from './client';

export {
  createJiraAccessVerifier,
  createConfluenceAccessVerifier,
  jiraRefId,
  confluenceRefId,
  type AtlassianCredentialLookup,
} from './verifier';

/** knowledge_chunks.provider values these verifiers answer for. */
export const JIRA_KNOWLEDGE_PROVIDER = 'jira';
export const CONFLUENCE_KNOWLEDGE_PROVIDER = 'confluence';
