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

/** The connector every tool in this server belongs to. */
export const JIRA_CONNECTOR = 'jira';

export function withCapabilityGate(server: McpServer, projection: CapabilityProjection): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config] = args;
          const readOnly = config.annotations?.readOnlyHint === true;
          const allowed = projection.allows({
            id: name,
            connector: JIRA_CONNECTOR,
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
