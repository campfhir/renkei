/**
 * The capability registry's enforcement point for the MCP surface.
 *
 * Tool modules register against a plain McpServer; this wraps one so every
 * registerTool call passes through the per-user capability projection
 * (@renkei/capability-registry) first. A tool the projection refuses is not
 * registered at all — it never appears in tools/list, which is what makes
 * the tool list a per-user projection rather than a global catalog
 * (RENKEI.md Decision #12).
 *
 * The capability descriptor is derived from what the tool itself declares:
 * its name, and its readOnlyHint annotation (absent hint = mutating — the
 * conservative reading).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { CapabilityProjection } from '@renkei/capability-registry';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

/** The connector the Jira/JSM tool modules register under. */
export const JIRA_CONNECTOR = 'jira';

/**
 * Gate an entire tool module behind a role, in addition to the usual
 * connector/read-write gate — e.g. `withCapabilityGate(server, projection,
 * ADMIN_CONNECTOR, ROLE_OPERATOR)` for a tool file that should never
 * register for a non-operator caller. Undefined (the default) means no
 * restriction beyond org policy and provisioning, same as before this
 * parameter existed.
 */
export function withCapabilityGate(
  server: McpServer,
  projection: CapabilityProjection,
  connector: string = JIRA_CONNECTOR,
  requiredRole?: string
): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config] = args;
          const readOnly = config.annotations?.readOnlyHint === true;
          const allowed = projection.allows({
            id: name,
            connector,
            kind: readOnly ? 'read' : 'act',
            requiredRole,
          });
          if (!allowed) return undefined;
          return target.registerTool(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Names the OAuth scopes a tool needs, given its name and whether it declared
 * readOnlyHint. Empty array = no scope requirement.
 */
export type ScopeRequirements = (toolName: string, readOnly: boolean) => string[];

/**
 * Registration-time scope filter, layered under the capability gate: a tool
 * whose required scopes the grant does not carry is never registered, so the
 * tool list reflects what this user actually authorized — not the full
 * catalog with 403s waiting inside (RENKEI.md Decision #12 again, applied to
 * scopes). `grantedScopes` undefined means the grant predates scope
 * recording; everything registers, and the call-time scope errors still
 * guide.
 */
export function withScopeGate(
  server: McpServer,
  grantedScopes: readonly string[] | undefined,
  requirements: ScopeRequirements
): McpServer {
  if (grantedScopes === undefined) return server;
  const granted = new Set(grantedScopes);
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config] = args;
          const readOnly = config.annotations?.readOnlyHint === true;
          const required = requirements(name, readOnly);
          if (!required.every((scope) => granted.has(scope))) return undefined;
          return target.registerTool(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Registration-time allow-list, layered under the other gates: only the
 * named tools register, whatever the connector, scope and role gates would
 * have allowed. An agent run's token carries this list (migration 096:
 * every tool its steps name), so the run's `tools/list` is a handful of
 * schemas instead of the owner's whole surface, and a call to any other
 * tool is refused before a gate ever sees it — the gateway-enforced twin
 * of the agent's own `blocked_tools`. Same Proxy shape as withScopeGate.
 */
export function withToolAllowList(server: McpServer, allowed: ReadonlySet<string>): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name] = args;
          if (!allowed.has(name)) return undefined;
          return target.registerTool(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Whether a tool is app-only: declared for a preview card's buttons
 * (`_meta.ui.visibility` without 'model' — widgets.ts's APP_ONLY_META), so
 * no model and no MCP client is meant to call it directly. Same reading
 * the tool catalog uses for its `appOnly` flag.
 */
export function isAppOnlyTool(config: RegisterToolArgs[1]): boolean {
  const meta: { ui?: { visibility?: unknown } } | undefined =
    typeof config._meta === 'object' && config._meta !== null ? config._meta : undefined;
  const visibility = meta?.ui?.visibility;
  return Array.isArray(visibility) && !visibility.includes('model');
}

/**
 * Registration-time gate for app-only tools, layered beside the allow-list:
 * a `*_confirm` tool registers ONLY for a token the chat's widget-card
 * confirm path minted (application 'widget' — mcp-token.ts). For every
 * other caller — an external MCP client, an agent run, a chat turn — it is
 * never registered, so `tools/list` never names it and `tools/call` finds
 * nothing to call. Until this existed the visibility was metadata only:
 * Renkei's own chat honored it, but an external client holding an OAuth
 * token could list and call the confirm half of a preview pair directly,
 * skipping the card the preview exists to put in front of a person.
 */
export function withAppOnlyGate(server: McpServer, callerIsWidget: boolean): McpServer {
  if (callerIsWidget) return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [, config] = args;
          if (isAppOnlyTool(config)) return undefined;
          return target.registerTool(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The refusal an app-only tool answers a caller that should never have reached it. */
export const APP_ONLY_REFUSAL =
  'This tool is invoked only by its preview card. Call the matching *_preview tool and let ' +
  'the person decide from the card.';

/**
 * Call-time twin of withAppOnlyGate, applied OUTERMOST on the raw server so
 * it holds whatever the registration layers inside it do: should an
 * app-only tool reach registration for a non-widget caller anyway (a gate
 * applied in the wrong order, a module registering on the raw server), its
 * handler is replaced with a refusal. Defense in depth — the registration
 * gate is what keeps the tool out of `tools/list`; this is what makes a
 * call fail closed if that ever slips.
 */
export function withAppOnlyCallGuard(server: McpServer, callerIsWidget: boolean): McpServer {
  if (callerIsWidget) return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          if (!isAppOnlyTool(config) || typeof handler !== 'function') {
            return target.registerTool(...args);
          }
          const refusing = async () => ({
            content: [{ type: 'text' as const, text: APP_ONLY_REFUSAL }],
            isError: true,
          });
          // The SDK types a handler as a union of result shapes, so a
          // replacement cannot be inferred across it; the refusal returns
          // one member of that union (text content + isError), which is
          // what the assertion states. Same idiom as withUsageTracking.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return target.registerTool(name, config, refusing as typeof handler);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
