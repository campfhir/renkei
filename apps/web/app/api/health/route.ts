import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getMigrationStatus, MIGRATION_COMMAND } from '@/lib/migrations/status';

/**
 * Liveness, and whether the schema matches this build.
 *
 * Answers 503 while migrations are pending. The app runs in that state — it
 * boots and serves what it can — but it is not correctly deployed, and a
 * deployment gate or container healthcheck is the right place to notice. It
 * previously answered ok unconditionally, so a build shipped ahead of its schema
 * looked healthy right up until an MCP client failed to register.
 */
export async function GET(): Promise<NextResponse> {
  logger.debug('[Health] Ping');

  const status = await getMigrationStatus();

  if (status.error) {
    return NextResponse.json(
      { status: 'degraded', reason: 'migration check failed', detail: status.error },
      { status: 503 }
    );
  }

  if (status.pending.length > 0) {
    return NextResponse.json(
      {
        status: 'degraded',
        reason: 'database schema is behind this build',
        pendingMigrations: status.pending,
        action: MIGRATION_COMMAND,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ status: 'ok', migrationsApplied: status.applied });
}
