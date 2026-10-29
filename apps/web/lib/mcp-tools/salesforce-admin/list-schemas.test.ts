/**
 * Every tool's input schema must convert to JSON Schema. One that does not
 * (a helper left uncalled, so a function sits where a schema should) makes
 * the MCP server's whole `tools/list` throw, and every chat that asks for
 * tools gets none — not just the one tool's connector.
 */

jest.mock('kysely', () => ({
  sql: Object.assign(() => ({ as: () => ({}) }), {
    raw: () => ({}),
    join: () => ({}),
    ref: () => ({}),
    lit: () => ({}),
  }),
}));
jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  },
  secure: (value: unknown) => value,
}));
// No reachable database: every data-store method rejects.
jest.mock('@renkei/db', () => ({
  getDataStore: () =>
    new Proxy(
      {},
      {
        get: () =>
          new Proxy(
            {},
            {
              get: () => async () => {
                throw new Error('no data store in this suite');
              },
            }
          ),
      }
    ),
}));

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ALL_SALESFORCE_ADMIN_SCOPES } from '@/lib/salesforce-admin-scopes';
import { ALL_SALESFORCE_SCOPES } from '@/lib/salesforce-scopes';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { registerSalesforceTools } from '../salesforce';
import { registerSalesforceAdminTools } from '.';

const auth: SalesforceAuth = {
  kind: 'oauth',
  resolve: async () => 'not connected',
};

/** Registers a connector's tools with every capability on; returns the names whose schema will not convert. */
function unconvertibleTools(register: (server: McpServer, context: MCPToolContext) => void): {
  registered: number;
  failures: string[];
} {
  const failures: string[] = [];
  let registered = 0;
  const collector = {
    registerTool: (name: string, config: { inputSchema?: z.ZodType }) => {
      registered += 1;
      try {
        const schema = config.inputSchema;
        if (schema !== undefined) z.toJSONSchema(schema, { io: 'input' });
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  const context = {
    subject: 'subject-1',
    salesforceScopes: ALL_SALESFORCE_SCOPES,
    salesforceAdminScopes: ALL_SALESFORCE_ADMIN_SCOPES,
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  register(collector as unknown as McpServer, context as unknown as MCPToolContext);
  return { registered, failures };
}

describe('Salesforce tool input schemas', () => {
  it('every Salesforce admin tool lists', () => {
    const { registered, failures } = unconvertibleTools((server, context) =>
      registerSalesforceAdminTools(server, context, auth)
    );
    expect(registered).toBeGreaterThan(10);
    expect(failures).toEqual([]);
  });

  it('every Salesforce tool lists', () => {
    const { registered, failures } = unconvertibleTools((server, context) =>
      registerSalesforceTools(server, context, auth)
    );
    expect(registered).toBeGreaterThan(10);
    expect(failures).toEqual([]);
  });
});
