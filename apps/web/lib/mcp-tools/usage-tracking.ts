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
 * WHAT IS RECORDED: which tool, who, when, how long, whether it reported
 * failure — and, ONLY on failure, a brief summary of the error text
 * (migration 037), so the caller has something to quote at a helpdesk
 * instead of "it keeps failing". WHAT IS NOT: arguments, or anything a
 * SUCCESSFUL call returned. Every argument this server takes is content —
 * the JQL someone searched, the person they mailed, the document they
 * opened — and usage telemetry has no business holding it; the schema has
 * nowhere to put it (migration 032). The error summary is projected only to
 * the caller themselves on the usage API — error text can quote inputs, and
 * content stays with its owner.
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
import { connectorKeyForTool } from './tool-connector';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

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

const ERROR_SUMMARY_MAX = 500;

/** Collapse to one schema-capped line; error text is prose, not a payload. */
function briefly(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, ERROR_SUMMARY_MAX) : null;
}

/**
 * The first text block of a FAILED result — the message errText built for
 * the model. Reads nothing unless isError is true, so a successful result
 * cannot reach the summary column even if this function is miswired: the
 * status check lives inside the extractor, not only at its call site.
 */
function errorSummaryOf(result: unknown): string | null {
  if (statusOf(result) !== 'error') return null;
  if (typeof result !== 'object' || result === null) return null;
  const { content }: { content?: unknown } = result;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, text }: { type?: unknown; text?: unknown } = block;
    if (type === 'text' && typeof text === 'string') return briefly(text);
  }
  return null;
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
  endedAt: Date,
  errorSummary: string | null
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
      connector: connectorKeyForTool(tool),
      status,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      // Belt and braces with errorSummaryOf's own guard: a success row
      // writes NULL here no matter what the extractor returned.
      error_summary: status === 'error' ? errorSummary : null,
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
              record(
                context,
                name,
                statusOf(result),
                startedAt,
                new Date(),
                errorSummaryOf(result)
              );
              return result;
            } catch (error) {
              // A throw is a failure that still happened, and its latency is
              // the interesting kind. Record, then let it propagate untouched.
              record(
                context,
                name,
                'error',
                startedAt,
                new Date(),
                briefly(error instanceof Error ? error.message : String(error))
              );
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
