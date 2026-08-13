import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';
import packageJson from '../package.json';

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

function buildLogger() {
  // Identity from the package manifest plus the build's git commit (baked in
  // as GIT_COMMIT by docker-build.sh), e.g. 0.1.0+4b9f475.
  const commit = process.env.GIT_COMMIT;
  const version = commit ? `${packageJson.version}+${commit}` : packageJson.version;

  const built = createLogger({
    application: packageJson.name,
    version,
    // The reserved `application`/`version` options above stamp every record
    // for storage and for a custom `.template()`, but the console adapter's
    // default rendering only ever prints `record.attrs` (never those two
    // fields) — see ConsoleAdapter's fallback path. Duplicating them into
    // the `attributes` bag (the documented way to reuse a name that collides
    // with an option, like `version` here) is what makes every printed
    // console line — not just an explicit boot line — carry
    // application/version/commit, so "what build produced this row" never
    // depends on scrolling back to find it.
    attributes: {
      application: packageJson.name,
      version,
      commit: commit ?? 'dev',
    },
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

type RenkeiLogger = ReturnType<typeof buildLogger>;
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForLogger = globalThis as unknown as { __renkeiLogger?: RenkeiLogger };

export const logger = (globalForLogger.__renkeiLogger ??= buildLogger());

export { secure, redact } from '@campfhir/bored-logs';
