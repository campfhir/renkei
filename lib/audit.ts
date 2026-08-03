import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

interface SessionInfo {
  tenantId: string;
  accountId: string;
  userAgent?: string;
  ipAddress?: string;
}

interface AuditLog {
  tenantId: string;
  accountId: string;
  toolName: string;
  userAgent?: string;
  ipAddress?: string;
  status: 'success' | 'failure';
  errorMessage?: string;
}

/**
 * Track or update a Jira session for a user
 */
export async function recordSession(session: SessionInfo): Promise<void> {
  const db = getDatabase();

  try {
    await db
      .insertInto('jira_sessions')
      .values({
        id: randomUUID(),
        tenant_id: session.tenantId,
        account_id: session.accountId,
        user_agent: session.userAgent,
        ip_address: session.ipAddress,
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'account_id', 'user_agent', 'ip_address']).doUpdateSet({
          last_used_at: new Date().toISOString(),
        })
      )
      .execute();
  } catch (error) {
    console.error('Failed to record session:', error);
  }
}

/**
 * Log a tool call with result
 */
export async function logToolCall(audit: AuditLog): Promise<void> {
  const db = getDatabase();

  try {
    await db
      .insertInto('mcp_audit_logs')
      .values({
        id: randomUUID(),
        tenant_id: audit.tenantId,
        account_id: audit.accountId,
        tool_name: audit.toolName,
        user_agent: audit.userAgent,
        ip_address: audit.ipAddress,
        status: audit.status,
        error_message: audit.errorMessage,
        created_at: new Date().toISOString(),
      })
      .execute();
  } catch (error) {
    console.error('Failed to log tool call:', error);
  }
}

/**
 * Get all sessions for a user
 */
export async function getUserSessions(
  tenantId: string,
  accountId: string
): Promise<
  Array<{
    id: string;
    userAgent: string | null;
    ipAddress: string | null;
    lastUsedAt: string;
    createdAt: string;
  }>
> {
  const db = getDatabase();

  return db
    .selectFrom('jira_sessions')
    .select(['id', 'user_agent as userAgent', 'ip_address as ipAddress', 'last_used_at as lastUsedAt', 'created_at as createdAt'])
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .orderBy('last_used_at', 'desc')
    .execute();
}

/**
 * Revoke a session
 */
export async function revokeSession(sessionId: string, tenantId: string): Promise<boolean> {
  const db = getDatabase();

  try {
    await db
      .deleteFrom('jira_sessions')
      .where('id', '=', sessionId)
      .where('tenant_id', '=', tenantId)
      .execute();

    return true;
  } catch (error) {
    console.error('Failed to revoke session:', error);
    return false;
  }
}

/**
 * Get audit logs for a tenant
 */
export async function getTenantAuditLogs(
  tenantId: string,
  limit = 100,
  offset = 0
): Promise<
  Array<{
    id: string;
    accountId: string;
    toolName: string;
    userAgent: string | null;
    ipAddress: string | null;
    status: string;
    errorMessage: string | null;
    createdAt: string;
  }>
> {
  const db = getDatabase();

  return db
    .selectFrom('mcp_audit_logs')
    .select([
      'id',
      'account_id as accountId',
      'tool_name as toolName',
      'user_agent as userAgent',
      'ip_address as ipAddress',
      'status',
      'error_message as errorMessage',
      'created_at as createdAt',
    ])
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
}

/**
 * Get audit logs for a specific user
 */
export async function getUserAuditLogs(
  tenantId: string,
  accountId: string,
  limit = 50,
  offset = 0
): Promise<
  Array<{
    id: string;
    toolName: string;
    status: string;
    errorMessage: string | null;
    createdAt: string;
  }>
> {
  const db = getDatabase();

  return db
    .selectFrom('mcp_audit_logs')
    .select(['id', 'tool_name as toolName', 'status', 'error_message as errorMessage', 'created_at as createdAt'])
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
}
