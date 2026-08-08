import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';

type RenkeiLogger = ReturnType<typeof createLogger>;

/**
 * Anchored on globalThis, not the module cache. Next bundles
 * instrumentation.ts, the server routes, and the proxy as separate
 * compilation graphs, and each graph evaluates this module separately — so a
 * plain module singleton yields several loggers, and the PostgresAdapter that
 * instrumentation attaches lands on a copy the routes never see. That is how
 * the logs table came to hold only instrumentation lines while stdout showed
 * everything. One process, one logger, whichever graph asks.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForLogger = globalThis as unknown as { __renkeiLogger?: RenkeiLogger };

/**
 * Where each legacy `[Tag]` prefix belongs in the service/component scheme.
 * Tags not listed fall back to their lowercased, dash-joined form.
 */
const COMPONENT_BY_TAG: Record<string, string> = {
  proxy: 'web/proxy',
  instrumentation: 'web/instrumentation',
  MCP: 'mcp/transport',
  'MCP Handler Error': 'mcp/transport',
  'MCP Metadata': 'mcp/metadata',
  Tool: 'mcp/tool',
  OAuth: 'auth/oauth',
  'OAuth Metadata': 'auth/oauth',
  OIDC: 'auth/oidc',
  Session: 'auth/session',
  Domain: 'auth/home-realm',
  Refresh: 'grants/refresh',
  jiraFetch: 'jira/fetch',
  AtlassianApp: 'connectors/atlassian',
  WebexApp: 'connectors/webex-user',
  'Webex webhook': 'webex/webhook',
  'bored-logs': 'logging/adapter',
};

const LEVEL_METHODS = new Set([
  'critical',
  'error',
  'warn',
  'info',
  'http',
  'verbose',
  'cache',
  'request',
  'response',
  'sql',
  'debug',
]);

/**
 * The style bridge: call sites write `logger.info('[MCP] message', ctx)` and
 * this lifts the bracket tag out of the message into a `component` attribute
 * (`component: 'mcp/transport'`) — a key the log API can filter, group, and
 * column on, where a message prefix could only be substring-matched. One
 * wrapper converts every call site in the codebase; an explicit `component`
 * in the context always wins over the extracted one.
 */
function withComponentAttr(base: RenkeiLogger): RenkeiLogger {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        typeof property === 'string' &&
        LEVEL_METHODS.has(property) &&
        typeof value === 'function'
      ) {
        return (message: unknown, context?: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          const call = value as (message: unknown, context?: Record<string, unknown>) => unknown;
          if (typeof message === 'string') {
            const match = /^\[([^\]]+)\]\s*/.exec(message);
            if (match) {
              const tag = match[1];
              const component = COMPONENT_BY_TAG[tag] ?? tag.toLowerCase().replace(/\s+/g, '-');
              const stripped = message.slice(match[0].length) || tag;
              return call.call(target, stripped, { component, ...(context ?? {}) });
            }
          }
          return call.call(target, message, context);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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

  return withComponentAttr(built);
}

export const logger = (globalForLogger.__renkeiLogger ??= buildLogger());

export { secure, redact } from '@campfhir/bored-logs';
