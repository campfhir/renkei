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

export function withCapabilityGate(
  server: McpServer,
  projection: CapabilityProjection,
  connector: string = JIRA_CONNECTOR
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
