/**
 * Stamps every tool RESULT with whether the tool reads or acts.
 *
 * `apps/web/lib/agents/run-actions.ts` explains why this is needed and where
 * it has to happen: read-vs-act is decided at registration time from
 * `annotations.readOnlyHint`, which is reachable only by running the whole
 * registration for a specific user against a database — so a run record
 * that wants to say "this changed something" cannot work it out afterwards,
 * and guessing from the tool's name would mislabel eventually. Its
 * conclusion, left as a note for whoever built this: *"record the kind on
 * the attempt at write time; do not infer it here."*
 *
 * This is that. A Proxy shaped exactly like `withCapabilityGate`, deriving
 * the kind from the same rule that gate uses (absent hint = mutating, the
 * conservative reading), and putting it on the result where the caller can
 * see it. Fifteen lines and no per-tool edits, so all ~135 act tools are
 * covered the day it lands rather than as each one is visited.
 *
 * The stamp MERGES into any `_meta` a handler already set. Clobbering it
 * would silently drop `renkei/outcome`, which is how a failure is
 * classified — a bug that would look like the classifier regressing.
 *
 * The model never sees this: the engine sends only the result's text back
 * into the conversation, so `_meta` travels to the worker and stops there.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { KIND_META_KEY, type ToolKind } from '@renkei/tool-outcomes';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

// The reader half — `toolKindOf`, and the key itself — lives in
// @renkei/tool-outcomes, because the agents worker consumes the stamp and
// cannot import from apps/web. This file is only the writer.
export { KIND_META_KEY, toolKindOf, type ToolKind } from '@renkei/tool-outcomes';

function stamped(result: unknown, kind: ToolKind): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const record: Record<string, unknown> = { ...result };
  const existing = record._meta;
  const meta: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...existing }
      : {};
  meta[KIND_META_KEY] = kind;
  record._meta = meta;
  return record;
}

/**
 * Wrap a server so each tool it registers stamps its own results.
 *
 * Apply this INNERMOST, closest to the real server, and let the capability
 * gate wrap the result: a tool the projection refuses is then never
 * registered and never wrapped. The other order works but does the wrapping
 * for tools that are about to be thrown away.
 */
export function withKindStamp(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          if (typeof handler !== 'function') return target.registerTool(...args);
          const kind: ToolKind = config.annotations?.readOnlyHint === true ? 'read' : 'act';

          const stamping = async (...handlerArgs: unknown[]) => {
            // The same two assertions withUsageTracking documents next door,
            // for the same reason: the SDK types a tool handler as a UNION of
            // result shapes, so Parameters/ReturnType over it collapse to the
            // wrong member and a generic cannot infer across the union. They
            // restate what this wrapper already guarantees — same arguments
            // in, same value out — rather than claiming anything new.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            const forwarded = handlerArgs as Parameters<typeof handler>;
            // A throw is deliberately NOT stamped: it produced no result to
            // stamp, and the throw path is the transport's to describe.
            return stamped(await handler(...forwarded), kind);
          };

          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return target.registerTool(name, config, stamping as typeof handler);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
