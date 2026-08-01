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
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
// Re-export UI components and utilities for admin console
export {
  LogTable,
  LogSearchBar,
  LogLevelFilter,
  LogDateRangePicker,
  LogCard,
  PurgeLogsDialog,
  LogTableRow,
  LogTableRowExpanded,
  LogTableRowGroup,
  LogSearchSyntaxHelp,
  formatTimestamp,
  DEFAULT_QUICK_RANGES,
} from '@campfhir/bored-logs/components';
export type {
  LogTableProps,
  LogSearchBarProps,
  LogLevelFilterProps,
  LogDateRangePickerProps,
  LogCardProps,
  LogTableRowProps,
  LogTableRowExpandedProps,
  LogTableRowGroupProps,
  ExtraColumn,
  LogCardField,
  LogDateRange,
  QuickRange,
  SortState,
  FilterExpr,
  LogQueryToken,
} from '@campfhir/bored-logs/components';

import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

/** Tenant-agnostic application logger. Logs can be filtered by tenant_id attribute. */
let instance: Logger | null = null;

/**
 * Initialize the application logger with PostgreSQL backend.
 * Must be called once at startup with the existing database pool.
 */
export function initializeLogger(pool: Pool): Logger {
  if (instance) return instance;

  // Create Kysely instance from the pg pool
  const db = new Kysely({
    dialect: new PostgresDialect({ pool }),
  });

  instance = createLogger({
    level: 'debug',
    application: 'renkei',
  });

  // Add PostgresAdapter with bored-logs' default table schema
  const adapter = new PostgresAdapter({ db });
  instance.addAdapter(adapter);

  return instance;
}

/**
 * Get the initialized logger. Throws if not yet initialized.
 */
export function getLogger(): Logger {
  if (!instance) {
    throw new Error('Logger not initialized. Call initializeLogger() at startup.');
  }
  return instance;
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
  tenantId: string;
  accountId?: string;
  method: string;
  path: string;
  statusCode: number;
  statusText?: string;
  message?: string;
}): void {
  getLogger().error('Jira API error: {method} {path} returned {statusCode}', {
    tenantId: attrs.tenantId,
    accountId: attrs.accountId || undefined,
    method: attrs.method,
    path: attrs.path,
    statusCode: attrs.statusCode,
    statusText: attrs.statusText,
  });
}

/** Log a grant/auth error. */
export function logAuthError(attrs: {
  tenantId: string;
  accountId?: string;
  reason: 'grant_missing' | 'grant_expired' | 'invalid_token' | 'token_revoked';
}): void {
  const messages = {
    grant_missing: 'Atlassian grant is missing',
    grant_expired: 'Atlassian grant has expired',
    invalid_token: 'Token is invalid or revoked',
    token_revoked: 'Token was revoked by operator',
  };

  getLogger().warn('Auth error: {reason}', {
    tenantId: attrs.tenantId,
    accountId: attrs.accountId || undefined,
    reason: attrs.reason,
    message: messages[attrs.reason],
  });
}

/** Log a rate limit hit. */
export function logRateLimit(attrs: {
  tenantId: string;
  accountId: string;
  limit: number;
  windowMinutes: number;
}): void {
  getLogger().warn('Rate limit exceeded: {accountId} hit {limit} calls', {
    tenantId: attrs.tenantId,
    accountId: attrs.accountId,
    limit: attrs.limit,
    windowMinutes: attrs.windowMinutes,
  });
}

/** Log an MCP tool error. */
export function logToolError(attrs: {
  tenantId: string;
  accountId: string;
  tool: string;
  errorCode?: string;
  message: string;
}): void {
  getLogger().error('MCP tool error: {tool} - {message}', {
    tenantId: attrs.tenantId,
    accountId: attrs.accountId,
    tool: attrs.tool,
    errorCode: attrs.errorCode || undefined,
    message: attrs.message,
  });
}
