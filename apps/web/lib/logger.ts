import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';

type RenkeiLogger = ReturnType<typeof createLogger>;

/**
 * Anchored on globalThis, not the module cache. Next bundles
 * instrumentation.ts, the server routes, and the proxy as separate
 * compilation graphs, and each graph evaluates this module separately — so a
 * plain module singleton yields several loggers, and the PostgresAdapter that
 * instrumentation attaches lands on a copy the routes never see. One
 * process, one logger, whichever graph asks.
 *
 * Logging style: messages carry no bracket prefix; every call site passes a
 * `component` attribute in the service/component scheme (web/proxy,
 * mcp/tool, auth/oauth, connectors/atlassian, …) so the log API can filter,
 * group, and column on it.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForLogger = globalThis as unknown as { __renkeiLogger?: RenkeiLogger };

function buildLogger(): RenkeiLogger {
  const built = createLogger({
    application: 'Renkei MCP Gateway',
    version: process.env.APP_VERSION ?? '0.1.0',
  });

  built.addAdapter(
    new ConsoleAdapter({
      level: process.env.CONSOLE_LOG_LEVEL ?? 'info',
      showTimestamp: true,
      showLevel: true,
      maskSecure: process.env.NODE_ENV === 'production',
    })
  );

  return built;
}

export const logger = (globalForLogger.__renkeiLogger ??= buildLogger());

export { secure, redact } from '@campfhir/bored-logs';
