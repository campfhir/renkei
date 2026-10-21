import { connectorKeyForTool } from './tool-connector';

describe('connectorKeyForTool for remote MCP servers', () => {
  it('maps <slug>__<tool> to the server capability key', () => {
    expect(connectorKeyForTool('acme_docs__search')).toBe('mcp-acme_docs');
    expect(connectorKeyForTool('acme__a__b')).toBe('mcp-acme');
  });

  it('leaves built-in names alone', () => {
    expect(connectorKeyForTool('jira_search')).toBe('jira');
    expect(connectorKeyForTool('whoami')).toBe('jira');
  });
});
