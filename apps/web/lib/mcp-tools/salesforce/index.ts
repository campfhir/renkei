/**
 * Salesforce CRM MCP tools (salesforce_*), over the caller's own grant on
 * the organization's Salesforce app, in the organization's own org.
 *
 * Instance-agnostic: nothing here knows any particular org. The tools know
 * the platform — objects and fields, ids and key prefixes, lookups,
 * master-detail and junction objects, record types and dependent
 * picklists, owners, activities, history, reports — and read everything
 * specific to an org from that org at call time (the describe), so the same
 * tools work on standard and custom objects in any org. An organization's
 * own procedures belong in prompt libraries and agents built on these.
 *
 * Built on the core REST resources — sObjects, query, search, sObject
 * Collections and Tree — plus the Reports and Dashboards REST API, all at
 * the pinned v68.0 (docs/salesforce-connectors-design.md, "Built on the
 * core REST resources"). Salesforce's own permissions decide every call;
 * Renkei's capabilities (lib/salesforce-scopes.ts) decide which tools
 * register.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { salesforceScopeFor } from './scopes';
import type { SalesforceAuth } from './salesforce-auth';
import { registerRecordReadTools } from './records';
import { registerWriteTools } from './writes';
import { registerBulkTools } from './bulk';
import { registerReportTools } from './reports';
import { registerFileTools } from './files';
import { registerOrgTools } from './orgs';
import { orgCall, orgField } from './org-choice';

export const SALESFORCE_MCP_CONNECTOR = 'salesforce';

export function registerSalesforceTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  // Fail closed: no recorded capabilities means no tools, never every tool
  // (withScopeGate passes everything through for `undefined`).
  const server = withOrgSelection(
    withScopeGate(rawServer, context.salesforceScopes ?? [], (name) => salesforceScopeFor(name))
  );

  registerOrgTools(server, context);
  registerRecordReadTools(server, context, auth);
  registerWriteTools(server, context, auth);
  registerBulkTools(server, context, auth);
  registerReportTools(server, context, auth);
  registerFileTools(server, context, auth);
}

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

/**
 * Every salesforce_ tool acts in one Salesforce org (connector). This adds
 * the optional `org` to each tool's input and runs the handler inside
 * `orgCall` with it and the tool's name, so the access the handler resolves
 * is that org's connection, checked against the tool's capability
 * (org-choice.ts) — one place, rather than in 40 handlers.
 */
function withOrgSelection(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          if (typeof handler !== 'function' || name === 'salesforce_list_orgs') {
            return target.registerTool(...args);
          }
          const schema = config.inputSchema;
          // Every tool here declares a z.object; `org` joins its fields — the
          // same config, one input field more.
          const withOrg =
            schema instanceof z.ZodObject
              ? Object.assign({}, config, { inputSchema: schema.extend({ org: orgField }) })
              : config;
          const scoped = async (...handlerArgs: unknown[]) => {
            const input = handlerArgs[0];
            const org =
              typeof input === 'object' &&
              input !== null &&
              'org' in input &&
              typeof input.org === 'string'
                ? input.org
                : undefined;
            // The same two assertions kind-stamp.ts documents: the SDK types a
            // handler as a union of result shapes, so a generic cannot infer
            // across it; this restates what the wrapper guarantees — same
            // arguments in, same value out.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            const forwarded = handlerArgs as Parameters<typeof handler>;
            return orgCall.run({ org, tool: name }, () => handler(...forwarded));
          };
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return target.registerTool(name, withOrg, scoped as typeof handler);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
