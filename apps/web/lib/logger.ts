import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';
import packageJson from '../package.json';

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
  // Identity from the package manifest plus the build's git commit (baked in
  // as GIT_COMMIT by docker-build.sh): every log row names the exact code
  // that produced it, e.g. 0.1.0+4b9f475 — no more guessing whether the
  // running image carries a fix.
  const commit = process.env.GIT_COMMIT;
  const built = createLogger({
    application: packageJson.name,
    version: commit ? `${packageJson.version}+${commit}` : packageJson.version,
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
