/**
 * Structured application logging via @campfhir/bored-logs.
 *
 * Captures API errors, auth failures, and tool execution events in a
 * queryable PostgreSQL backend accessible to tenant admins via the
 * admin console. Excludes chat content and request payloads.
 *
 * Re-exports React UI components for admin dashboards:
 * - LogTable, LogSearchBar, LogLevelFilter, LogDateRangePicker
 * - LogCard, PurgeLogsDialog
 * - LogTableRow, LogTableRowExpanded, LogTableRowGroup
 * - formatTimestamp, FilterExpr and other utilities
 */

import { createLogger, type Logger } from '@campfhir/bored-logs';
import { getDataStore } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/** Tenant-agnostic application logger. Logs can be filtered by tenant_id attribute. */
let instance: Logger | null = null;

/**
 * Initialize the application logger, writing to the log tables through the
 * data store (bored-logs' PostgresAdapter on Postgres). Call once at startup.
 */
export function initializeLogger(): Logger {
  if (instance) return instance;

  instance = createLogger({
    level: 'debug',
    application: 'renkei',
  });

  // bored-logs' default table schema, at the adapter's default level.
  instance.addAdapter(getDataStore().activityLogs.writer());

  return instance;
}

/**
 * Get the initialized logger. Returns an error if not yet initialized.
 */
export function getLogger(): Result<Logger, 'LOGGER_NOT_INITIALIZED'> {
  if (!instance) {
    return err('LOGGER_NOT_INITIALIZED' as const, {
      message: 'Logger not initialized. Call initializeLogger() at startup.',
    });
  }
  return ok(instance);
}

/**
 * Flush all pending log writes. Call during graceful shutdown.
 */
export async function flushLogger(): Promise<void> {
  if (instance) {
    await instance.flush();
  }
}

/**
 * Close the logger. Call during graceful shutdown.
 */
export async function closeLogger(): Promise<void> {
  if (instance) {
    await instance.close();
  }
}

/** Log a Jira API error. */
export function logJiraError(attrs: {
  accountId?: string;
  method: string;
  path: string;
  statusCode: number;
  statusText?: string;
  message?: string;
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  logger.error('Jira API error: {method} {path} returned {statusCode}', {
    accountId: attrs.accountId || undefined,
    method: attrs.method,
    path: attrs.path,
    statusCode: attrs.statusCode,
    statusText: attrs.statusText,
  });
  return ok();
}

/** Log a grant/auth error. */
export function logAuthError(attrs: {
  accountId?: string;
  reason: 'grant_missing' | 'grant_expired' | 'invalid_token' | 'token_revoked';
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  const messages = {
    grant_missing: 'Atlassian grant is missing',
    grant_expired: 'Atlassian grant has expired',
    invalid_token: 'Token is invalid or revoked',
    token_revoked: 'Token was revoked by operator',
  };

  logger.warn('Auth error: {reason}', {
    accountId: attrs.accountId || undefined,
    reason: attrs.reason,
    message: messages[attrs.reason],
  });
  return ok();
}

/** Log a rate limit hit. */
export function logRateLimit(attrs: {
  accountId: string;
  limit: number;
  windowMinutes: number;
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  logger.warn('Rate limit exceeded: {accountId} hit {limit} calls', {
    accountId: attrs.accountId,
    limit: attrs.limit,
    windowMinutes: attrs.windowMinutes,
  });
  return ok();
}

/** Log an MCP tool error. */
export function logToolError(attrs: {
  accountId: string;
  tool: string;
  errorCode?: string;
  message: string;
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  logger.error('MCP tool error: {tool} - {message}', {
    accountId: attrs.accountId,
    tool: attrs.tool,
    errorCode: attrs.errorCode || undefined,
    message: attrs.message,
  });
  return ok();
}
