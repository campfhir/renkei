/**
 * Keeps one broken tool from taking every tool down with it.
 *
 * `tools/list` converts each registered tool's schema to JSON Schema, and a
 * schema that cannot convert (a helper left uncalled, so a function sits
 * where a schema should) makes the whole call throw — for every connector,
 * for everyone who has the broken tool registered. Chat then runs with no
 * tools at all and the model reports them missing.
 *
 * This converts each schema once at registration. A tool that fails is
 * left out and named in the log; the rest list as usual. The tool is
 * still a bug to fix, but it costs its own connector one tool, not every
 * tool in the product.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { logger } from '@/lib/logger';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

function convertible(schema: unknown): string | null {
  // Only Zod schemas are checked; the conversion is Zod's, and that is what
  // every tool here is written in.
  if (!(schema instanceof z.core.$ZodType)) return null;
  try {
    z.toJSONSchema(schema, { io: 'input' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function withSchemaGuard(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config] = args;
          const problem = convertible(config.inputSchema) ?? convertible(config.outputSchema);
          if (problem !== null) {
            logger.error('tool {tool} left out: its schema does not convert: {error}', {
              component: 'mcp/schema-guard',
              tool: name,
              error: problem,
            });
            return undefined;
          }
          return target.registerTool(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
