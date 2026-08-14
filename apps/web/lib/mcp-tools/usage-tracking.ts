/**
 * Recording that a tool ran — the third registerTool proxy, alongside the
 * capability and scope gates.
 *
 * A proxy rather than a line in every handler, for the same reason those two
 * are: there are 200-odd tools across nine namespaces, and instrumentation
 * that must be remembered per tool is instrumentation that will be missing
 * from the one that matters. Wrapping registration means a tool cannot be
 * added without being measured.
 *
 * WHAT IS RECORDED: which tool, who, when, how long, and whether it reported
 * failure. WHAT IS NOT: arguments or results. Every argument this server
 * takes is content — the JQL someone searched, the person they mailed, the
 * document they opened — and usage telemetry has no business holding it. The
 * schema has nowhere to put it, which is the durable version of this comment
 * (migration 032).
 *
 * Recording never blocks the caller and never breaks a call. The insert is
 * fired without awaiting, because the measurement exists to find latency
 * rather than to add it, and a failure to write is swallowed: a telemetry
 * outage must not become a tool outage. The cost is losing a few rows if the
 * process dies mid-flight, which is the right trade for counts.
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { logger } from '@/lib/logger';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

/** The connector a tool belongs to, from its name. */
function connectorOf(toolName: string): string | null {
  const underscore = toolName.indexOf('_');
  return underscore > 0 ? toolName.slice(0, underscore) : null;
}

/**
 * MCP handlers signal failure with `isError` on the result rather than by
 * throwing, so a status read from the return value catches the ordinary
 * failure path; a throw is caught separately and re-thrown.
 */
function statusOf(result: unknown): 'ok' | 'error' {
  if (typeof result === 'object' && result !== null && 'isError' in result) {
    return result.isError === true ? 'error' : 'ok';
  }
  return 'ok';
}

export interface UsageContext {
  tenantId: string;
  /** OIDC subject; usage is attributed deliberately (see migration 032). */
  subject: string | null;
}

function record(
  context: UsageContext,
  tool: string,
  status: 'ok' | 'error',
  startedAt: Date,
  endedAt: Date
): void {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;

  void dbResult.val
    .insertInto('tool_calls')
    .values({
      id: randomUUID(),
      tenant_id: context.tenantId,
      subject: context.subject,
      tool,
      connector: connectorOf(tool),
      status,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    })
    .execute()
    .catch((error: unknown) => {
      // Debug, not warn: a busy server that cannot write telemetry would
      // otherwise flood the log with a problem nobody can act on per-call.
      logger.debug('tool usage not recorded: {error}', {
        component: 'mcp/usage',
        tenantId: context.tenantId,
        tool,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function withUsageTracking(server: McpServer, context: UsageContext): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          if (typeof handler !== 'function') return target.registerTool(...args);

          const timed = async (...handlerArgs: unknown[]) => {
            const startedAt = new Date();
            // The SDK types a tool handler as a UNION of result shapes, so
            // Parameters/ReturnType over it collapse to the wrong member and a
            // generic cannot infer across the union. These two assertions
            // restate what the wrapper already guarantees — same arguments in,
            // same value out — rather than claiming anything new.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            const forwarded = handlerArgs as Parameters<typeof handler>;
            try {
              const result: unknown = await handler(...forwarded);
              record(context, name, statusOf(result), startedAt, new Date());
              return result;
            } catch (error) {
              // A throw is a failure that still happened, and its latency is
              // the interesting kind. Record, then let it propagate untouched.
              record(context, name, 'error', startedAt, new Date());
              throw error;
            }
          };

          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return target.registerTool(name, config, timed as typeof handler);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
