/**
 * The `web_search` tool — public-web search through the org's Azure OpenAI
 * (or OpenAI) Responses API deployment and its built-in `web_search` tool,
 * which on Azure is Grounding with Bing.
 *
 * Why a tool rather than a model feature: Renkei hosts no models and the
 * chat/agent model may well be Claude, or a deployment without web access.
 * Routing search through one org-configured deployment means every caller
 * — an external MCP client, the first-party chat, an agent run — gets the
 * same search, under the same org policy (location, domain lists), paid
 * for on one key an admin can see.
 *
 * What leaves the building: the query string, and the location/domain
 * settings. Nothing from the caller's other tools, nothing about who is
 * asking — the provider sees a query, not a person. Microsoft's own terms
 * note that Grounding with Bing sits outside the Azure compliance
 * boundary, which is why this is an org-provisioned connector an admin
 * switches on, never a default.
 *
 * Registration is I/O-free (the config is resolved per call), which the
 * tools page's enumerating server depends on — see registry.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { logger } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import {
  domainWithin,
  normalizeDomain,
  parseLocation,
  resolveWebSearchConfig,
  type WebSearchConfig,
} from './config';
import { runWebSearch, type WebSearchOutcome, type WebSearchRequest } from './client';

export { WEB_SEARCH_CONNECTOR } from './config';

const MAX_QUERY_CHARS = 2_000;
const MAX_CALLER_DOMAINS = 20;

/** Swappable for tests; production uses the real resolver and client. */
export interface WebSearchDeps {
  resolveConfig: (tenantId: string) => Promise<WebSearchConfig | null>;
  search: (config: WebSearchConfig, request: WebSearchRequest) => Promise<WebSearchOutcome>;
}

const productionDeps: WebSearchDeps = {
  resolveConfig: resolveWebSearchConfig,
  search: runWebSearch,
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const locationSchema = z
  .object({
    country: z
      .string()
      .length(2)
      .optional()
      .describe('Two-letter ISO 3166-1 country code, e.g. "US".'),
    city: z.string().max(100).optional().describe('Free-text city name, e.g. "Chicago".'),
    region: z
      .string()
      .max(100)
      .optional()
      .describe('Free-text region or state name, e.g. "Illinois".'),
    timezone: z
      .string()
      .max(64)
      .optional()
      .describe('IANA time zone identifier, e.g. "America/Chicago".'),
  })
  .describe(
    "Approximate location to tune results to, when the user's question is local (weather, " +
      'news, businesses, events). Overrides the org default for this search only.'
  );

/**
 * The caller's domain narrowing, held within the org's allowlist when one
 * is set: a model may search a subset of what the org permits, never
 * beyond it. Returns the list to send, and the entries that were dropped.
 */
export function narrowDomains(
  requested: string[],
  orgAllowed: string[]
): { allowed: string[]; rejected: string[] } {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const entry of requested.slice(0, MAX_CALLER_DOMAINS)) {
    const domain = normalizeDomain(entry);
    if (!domain) {
      rejected.push(entry);
      continue;
    }
    if (orgAllowed.length > 0 && !orgAllowed.some((org) => domainWithin(domain, org))) {
      rejected.push(entry);
      continue;
    }
    if (!allowed.includes(domain)) allowed.push(domain);
  }
  return { allowed, rejected };
}

export function registerWebSearchTools(
  server: McpServer,
  context: MCPToolContext,
  deps: WebSearchDeps = productionDeps
): void {
  server.registerTool(
    'web_search',
    {
      title: 'Web · Read — Search the public web',
      description:
        "Search the public web and get a grounded, cited answer — through the organization's " +
        'Azure OpenAI deployment and its built-in web search (Grounding with Bing). Use it for ' +
        'anything current or external: news, prices, releases, documentation, public facts ' +
        'not in org knowledge. Results carry source URLs; cite them back to the user. Phrase ' +
        '"query" as the question or topic to look up, not as keywords. Pass "domains" to ' +
        'limit results to specific sites, and "location" when the question is local.\n\n' +
        'Not for org content: search_knowledge and the connector tools cover that, with ' +
        'access checks this tool does not have. Each call is billed as a web search.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_CHARS)
          .describe('What to look up — a question or topic, in natural language.'),
        domains: z
          .array(z.string().max(253))
          .max(MAX_CALLER_DOMAINS)
          .optional()
          .describe(
            'Only return results from these sites (bare hosts like "learn.microsoft.com"; ' +
              'subdomains included). When the organization has its own allowlist, entries ' +
              'outside it are ignored.'
          ),
        location: locationSchema.optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return errText('"query" is required.');
      if (query.length > MAX_QUERY_CHARS) {
        return errText(`"query" is too long (max ${MAX_QUERY_CHARS} characters).`);
      }

      // Resolved per call, not captured at registration: an admin's key
      // rotation or disable must bite within the config cache TTL, not
      // whenever this caller's handler happens to be rebuilt.
      const config = await deps.resolveConfig(context.tenantId);
      if (!config) {
        return errText(
          'Web search is not configured for this organization — an admin sets the Azure ' +
            'OpenAI endpoint, deployment and key under Organization → Connector setup → Web search.'
        );
      }

      const notes: string[] = [];
      let allowedDomains: string[] | undefined;
      if (Array.isArray(args.domains) && args.domains.length > 0) {
        const requested = args.domains.filter(
          (entry): entry is string => typeof entry === 'string'
        );
        const narrowed = narrowDomains(requested, config.allowedDomains);
        if (narrowed.rejected.length > 0) {
          notes.push(
            `Ignored domains (${
              config.allowedDomains.length > 0
                ? "not within the organization's allowlist, or not a hostname"
                : 'not a hostname'
            }): ${narrowed.rejected.join(', ')}.`
          );
        }
        if (narrowed.allowed.length === 0 && narrowed.rejected.length > 0) {
          return errText(
            `None of the requested domains can be searched. ${notes.join(' ')}${
              config.allowedDomains.length > 0
                ? ` The organization limits web search to: ${config.allowedDomains.join(', ')}.`
                : ''
            }`
          );
        }
        if (narrowed.allowed.length > 0) allowedDomains = narrowed.allowed;
      }

      const location = parseLocation(args.location);

      const outcome = await deps.search(config, {
        query,
        ...(location ? { location } : {}),
        ...(allowedDomains ? { allowedDomains } : {}),
      });
      if (!outcome.ok) {
        // The key is the org's, so an auth failure is for the admin, not
        // the caller — say so rather than echoing a bare 401.
        logger.warn('web_search failed: {message}', {
          component: 'mcp/web-search',
          tenantId: context.tenantId,
          subject: context.subject,
          kind: outcome.error.kind,
          message: outcome.error.message,
        });
        switch (outcome.error.kind) {
          case 'auth':
            return errText(
              "The web-search endpoint rejected the organization's API key. An admin needs to " +
                `check the key under Connector setup → Web search. (${outcome.error.message})`
            );
          case 'not_found':
            return errText(
              'The web-search endpoint or deployment was not found — the base URL or deployment ' +
                `name under Connector setup → Web search is likely wrong. (${outcome.error.message})`
            );
          case 'rate_limit':
            return errText(
              `The web-search endpoint is rate-limiting requests; try again shortly. (${outcome.error.message})`
            );
          case 'timeout':
          case 'network':
            return errText(outcome.error.message);
          default:
            return errText(`Web search failed: ${outcome.error.message}`);
        }
      }

      const result = outcome.val;
      const lines: string[] = [];
      if (!result.searched) {
        lines.push(
          'Note: the model answered WITHOUT performing a web search — treat this as unverified ' +
            'and consider rephrasing the query to ask explicitly for current information.'
        );
      }
      if (result.status) {
        lines.push(
          `Note: the provider reported status "${result.status}" — the answer may be cut short.`
        );
      }
      lines.push(...notes);
      if (lines.length > 0) lines.push('');

      lines.push(result.text || '(The search returned no text.)');

      if (result.citations.length > 0) {
        lines.push('', 'Sources:');
        result.citations.forEach((citation, index) => {
          lines.push(
            `${index + 1}. ${citation.title ? `${citation.title} — ` : ''}${citation.url}`
          );
        });
      } else if (result.sources.length > 0) {
        lines.push('', 'Sources consulted:');
        result.sources.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
      }

      if (result.queries.length > 0) {
        lines.push('', `Searched for: ${result.queries.map((q) => `"${q}"`).join(', ')}`);
      }

      return textResult(lines.join('\n'));
    }
  );
}

/** Whether the org has provisioned web search — the registry's availability probe. */
export async function webSearchConfigured(tenantId: string): Promise<boolean> {
  return (await resolveWebSearchConfig(tenantId)) !== null;
}
