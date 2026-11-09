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
import { getDataStore, actorFields, type Actor } from '@renkei/db';
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

/**
 * Who a line is about, in words: the person when the caller has resolved
 * them (`actor`), else the provider account id, else nobody in particular.
 * These helpers are synchronous, so the caller resolves the actor where it
 * is async (`describeAccountActor` / `describeActor` from @renkei/db).
 */
function whoFields(actor: Actor | undefined, accountId: string | undefined) {
  return {
    ...(actor ? actorFields(actor) : {}),
    accountId: accountId || undefined,
    who: actor ? actor.label : accountId ? `the account ${accountId}` : 'an unknown account',
  };
}

/** Log a Jira API error. */
export function logJiraError(attrs: {
  accountId?: string;
  /** The person behind the account, when the caller knows them. */
  actor?: Actor;
  method: string;
  path: string;
  statusCode: number;
  statusText?: string;
  message?: string;
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  logger.error(
    "Jira answered {who}'s {method} {path} with HTTP {statusCode}; the call did not go through",
    {
      ...whoFields(attrs.actor, attrs.accountId),
      method: attrs.method,
      path: attrs.path,
      statusCode: attrs.statusCode,
      statusText: attrs.statusText,
      ...(attrs.message ? { message: attrs.message } : {}),
    }
  );
  return ok();
}

/** Log a grant/auth error. */
export function logAuthError(attrs: {
  accountId?: string;
  /** The person behind the account, when the caller knows them. */
  actor?: Actor;
  reason: 'grant_missing' | 'grant_expired' | 'invalid_token' | 'token_revoked';
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  const messages = {
    grant_missing: 'has no Atlassian grant',
    grant_expired: 'has an Atlassian grant that expired',
    invalid_token: 'presented a token that is invalid or revoked',
    token_revoked: 'had their token revoked by an operator',
  };

  logger.warn('{who} {what}; the call was refused and they must connect again', {
    ...whoFields(attrs.actor, attrs.accountId),
    reason: attrs.reason,
    what: messages[attrs.reason],
    message: messages[attrs.reason],
  });
  return ok();
}

/** Log a rate limit hit. */
export function logRateLimit(attrs: {
  accountId: string;
  /** The person behind the account, when the caller knows them. */
  actor?: Actor;
  limit: number;
  windowMinutes: number;
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  logger.warn(
    '{who} made more than {limit} calls in {windowMinutes} minutes and hit the rate limit; further calls are refused until the window passes',
    {
      ...whoFields(attrs.actor, attrs.accountId),
      limit: attrs.limit,
      windowMinutes: attrs.windowMinutes,
    }
  );
  return ok();
}

/** Log an MCP tool error. */
export function logToolError(attrs: {
  accountId: string;
  /** The person behind the account, when the caller knows them. */
  actor?: Actor;
  tool: string;
  errorCode?: string;
  message: string;
}): Result<void, 'LOGGER_NOT_INITIALIZED'> {
  const loggerResult = getLogger();
  if (!loggerResult.ok) return loggerResult;
  const logger = loggerResult.val;

  logger.error('the tool {tool} failed for {who}; the caller was told: {message}', {
    ...whoFields(attrs.actor, attrs.accountId),
    tool: attrs.tool,
    errorCode: attrs.errorCode || undefined,
    message: attrs.message,
  });
  return ok();
}
