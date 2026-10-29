import { scopedLogger, withLogSubject } from './log-scope';
import type { DelegateLogger } from './grants';

function recorder() {
  const lines: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, context?: Record<string, unknown>) =>
    lines.push({ level, message, context });
  const base: DelegateLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { lines, logger: scopedLogger(base) };
}

it('stamps the op subject’s hash on every line written inside the scope, never the subject', async () => {
  const { lines, logger } = recorder();
  await withLogSubject('sub-1', async () => {
    await Promise.resolve();
    logger.warn('grant refresh failed', { provider: 'microsoft' });
  });
  // The web app's Activity view matches this same value (apps/web/lib/log-query.ts).
  expect(lines).toEqual([
    {
      level: 'warn',
      message: 'grant refresh failed',
      context: { subjectHash: '0a80627d4936eb43', provider: 'microsoft' },
    },
  ]);
  expect(JSON.stringify(lines)).not.toContain('sub-1');
});

it('leaves lines outside a scope, or for an op with no subject, as they were', () => {
  const { lines, logger } = recorder();
  logger.error('boot failed', { error: 'x' });
  withLogSubject('', () => logger.info('keys/instances'));
  expect(lines.map((line) => line.context)).toEqual([{ error: 'x' }, undefined]);
});
