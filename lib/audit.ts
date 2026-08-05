import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

interface SessionInfo {
  tenantId: string;
  accountId: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Track or update a Jira session for a user
 */
export async function recordSession(session: SessionInfo): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

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
    return ok();
  } catch (error) {
    console.error('Failed to record session:', error);
    return err('DB_ERROR' as const);
  }
}

/**
 * Get all sessions for a user
 */
export async function getUserSessions(
  tenantId: string,
  accountId: string
): Promise<
  Result<
    Array<{
      id: string;
      userAgent: string | null;
      ipAddress: string | null;
      lastUsedAt: Date;
      createdAt: Date;
    }>,
    'DB_ERROR'
  >
> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  try {
    const result = await db
      .selectFrom('jira_sessions')
      .select(['id', 'user_agent as userAgent', 'ip_address as ipAddress', 'last_used_at as lastUsedAt', 'created_at as createdAt'])
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .orderBy('last_used_at', 'desc')
      .execute();
    return ok(result);
  } catch (error) {
    return err('DB_ERROR' as const);
  }
}

/**
 * Revoke a session
 */
export async function revokeSession(sessionId: string, tenantId: string): Promise<Result<boolean, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  try {
    await db
      .deleteFrom('jira_sessions')
      .where('id', '=', sessionId)
      .where('tenant_id', '=', tenantId)
      .execute();

    return ok(true);
  } catch (error) {
    console.error('Failed to revoke session:', error);
    return err('DB_ERROR' as const);
  }
}
