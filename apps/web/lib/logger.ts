import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';

export const logger = createLogger({
  application: 'Renkei MCP Gateway',
  version: process.env.APP_VERSION ?? '0.1.0',
});

logger.addAdapter(
  new ConsoleAdapter({
    level: process.env.CONSOLE_LOG_LEVEL ?? 'info',
    showTimestamp: true,
    showLevel: true,
    maskSecure: process.env.NODE_ENV === 'production',
  })
);

export { secure, redact } from '@campfhir/bored-logs';
