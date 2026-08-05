import { logger } from '@/lib/logger';
import { getDatabase } from '@/lib/db';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { PostgresAdapter } = await import('@campfhir/bored-logs/adapters/psql');

    const dbResult = getDatabase();
    if (!dbResult.ok) {
      logger.error('[instrumentation] Failed to initialize database for bored-logs', {
        error: String(dbResult.err),
      });
      return;
    }

    logger.addAdapter(
      new PostgresAdapter({
        db: dbResult.val,
        level: process.env.LOG_DB_LEVEL ?? 'info',
        onWarning(w) {
          if (w.type === 'attr_keys_truncated') {
            logger.warn('[bored-logs] attribute keys truncated', {});
          } else if (w.type === 'attr_value_truncated') {
            logger.warn('[bored-logs] attribute value truncated', {});
          }
        },
      })
    );

    logger.info('[instrumentation] PostgresAdapter registered', {
      level: process.env.LOG_DB_LEVEL ?? 'info',
    });
  }
}
