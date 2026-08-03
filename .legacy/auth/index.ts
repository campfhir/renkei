/**
 * Atlassian OAuth 2.0 (3LO) broker and MCP OAuth 2.1 resource-server handshake.
 * Implemented in Phase 1 (see README § Delivery Plan).
 *
 * PKCE applies to the MCP client -> Renkei leg only. The Renkei -> Atlassian
 * leg is a confidential-client authorization-code exchange: Atlassian 3LO does
 * not publicly support PKCE (ECO-283). See README § Authentication flow.
 *
 * Shape reserved now so downstream modules (server bootstrap, tools) can
 * depend on the session type without churn once the broker lands.
 */

export interface Session {
  id: string;
  atlassianAccountId: string;
  cloudId: string;
  createdAt: Date;
  lastActiveAt: Date;
}
