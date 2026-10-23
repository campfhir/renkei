/**
 * Which Salesforce connector (org) a tool call acts in.
 *
 * Every salesforce_ tool takes an optional `org` — a connector's name or key
 * (Production, UAT…). index.ts adds it to each tool's input and runs the
 * handler inside `orgCall`, carrying the org asked for and the tool's name,
 * so resolving access is one place: pick the person's connection to that
 * connector, and refuse a tool the connection's own capabilities do not
 * cover (registration only knows the union across a person's connections).
 *
 * With no `org`: a person connected to one org gets it; connected to
 * several, production when exactly one is, and otherwise a refusal naming
 * them — never a guess about which org a write lands in.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { findOrg, type SalesforceOrg } from '@renkei/connector-salesforce';
import type { SalesforceConnection } from '@/lib/salesforce-grants';

export const orgCall = new AsyncLocalStorage<{ org?: string; tool: string }>();

export const orgField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Which Salesforce org: a connector’s name or key (Production, UAT…), as salesforce_list_orgs ' +
      'lists them. Optional when the person is connected to one org, or to one production org; ' +
      'name it to act in a sandbox.'
  );

/** The admin connector's: no default between several orgs, since its proposals change an org. */
export const adminOrgField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Which Salesforce org to build in: a connector’s name or key (UAT, Production…), as ' +
      'salesforce_admin_list_orgs lists them. Optional only when the person is connected to one org.'
  );

export type OrgChoice =
  { ok: true; org: SalesforceOrg; connection: SalesforceConnection } | { ok: false; error: string };

function names(orgs: readonly SalesforceOrg[]): string {
  return orgs.map((org) => `${org.name}${org.sandbox ? ' (sandbox)' : ''}`).join(', ');
}

/**
 * The connection to use, from the switched-on connectors, the person's
 * connections, the org asked for and the capabilities the tool needs.
 * `label` names the connector type in what it says. With several
 * connections and no org named, the CRM takes the one production org; the
 * admin connector (`preferProduction: false`) always asks, since what it
 * proposes changes an org's setup.
 */
export function chooseConnection(
  connectors: readonly SalesforceOrg[],
  connections: readonly SalesforceConnection[],
  ref: string | undefined,
  needs: readonly string[],
  label = 'Salesforce',
  preferProduction = true
): OrgChoice {
  const live = connectors.filter((org) => org.enabled);
  const connected = live.filter((org) => connections.some((c) => c.connector === org.key));
  if (live.length === 0) {
    return { ok: false, error: `${label} is not set up for this organization.` };
  }
  let org: SalesforceOrg | null;
  if (ref) {
    org = findOrg(live, ref);
    if (!org) {
      return {
        ok: false,
        error: `There is no ${label} org "${ref}". The organization’s ${label} orgs: ${names(live)}.`,
      };
    }
    if (!connected.includes(org)) {
      return {
        ok: false,
        error: `You are not connected to ${label} ${org.name}. Connect it on the Connectors page, then try again.`,
      };
    }
  } else if (connected.length === 1) {
    org = connected[0];
  } else if (connected.length === 0) {
    return {
      ok: false,
      error: `${label} is not connected. Connect an org on the Connectors page, then try again.`,
    };
  } else {
    const production = connected.filter((candidate) => !candidate.sandbox);
    if (!preferProduction || production.length !== 1) {
      return {
        ok: false,
        error: `You are connected to several ${label} orgs (${names(connected)}); say which with org.`,
      };
    }
    org = production[0];
  }
  const connection = connections.find((c) => c.connector === org.key);
  if (!connection) return { ok: false, error: `You are not connected to ${label} ${org.name}.` };
  const missing = needs.filter(
    (scope) => scope !== '__unmapped__' && !connection.requestedScopes.includes(scope)
  );
  if (needs.includes('__unmapped__')) {
    return { ok: false, error: 'This tool is not mapped to a Salesforce capability.' };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Your ${label} ${org.name} connection does not allow this (${missing.join(', ')}). ` +
        'Reconnect that org on the Connectors page with it ticked, if your organization allows it.',
    };
  }
  return { ok: true, org, connection };
}

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

/**
 * Every tool of a Salesforce connector type acts in one org (connector). This adds
 * the optional `org` to each tool's input and runs the handler inside
 * `orgCall` with it and the tool's name, so the access the handler resolves
 * is that org's connection, checked against the tool's capability
 * (above) — one place, rather than in 40 handlers. `listTool` (the tool that
 * lists the orgs) takes none.
 */
export function withOrgSelection(
  server: McpServer,
  listTool: string,
  field: z.ZodOptional<z.ZodString>
): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          if (typeof handler !== 'function' || name === listTool) {
            return target.registerTool(...args);
          }
          const schema = config.inputSchema;
          // Every tool here declares a z.object; `org` joins its fields — the
          // same config, one input field more.
          const withOrg =
            schema instanceof z.ZodObject
              ? Object.assign({}, config, { inputSchema: schema.extend({ org: field }) })
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
