/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Project structure tools for Jira MCP.
 * Discover components, fields, versions, and users.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, withPresentationHint } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

/**
 * How many people one `jira_search_users` call may look up.
 *
 * A cap rather than unbounded fan-out: past a couple of dozen the caller
 * wants a group (`jira_list_group_members`) or a project role, not a list
 * of names, and an unbounded batch is an easy way to spend a site's whole
 * rate-limit budget in one tool call.
 */
const MAX_USER_QUERIES = 25;

/**
 * Jira's user search is rate limited per site. A batch naming a dozen
 * people would otherwise open a dozen sockets at once and start collecting
 * 429s, which costs more wall clock than the queueing ever saved.
 */
const USER_SEARCH_CONCURRENCY = 5;

type UserSearchResult =
  { ok: true; query: string; users: any[] } | { ok: false; query: string; reason: string };

/**
 * One directory search, with the term it was for kept alongside the answer.
 *
 * Nothing escapes as a rejection: a batch runs these concurrently, and one
 * name that times out or answers unparseable JSON must cost that name only
 * — not the matches already found for everyone else.
 */
async function searchUsersOnce(
  auth: JiraAuth,
  query: string,
  limit: number
): Promise<UserSearchResult> {
  try {
    const response = await auth.fetch(
      granularJiraScopes('jira_search_users', true),
      `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${limit}`
    );
    if (!response.ok) return { ok: false, query, reason: await describeJiraAuthFailure(response) };
    const body: unknown = await response.json();
    return { ok: true, query, users: Array.isArray(body) ? body : [] };
  } catch (error) {
    return { ok: false, query, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Run `work` over `items` at most `limit` at a time, preserving order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function registerProjectTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_projects
  server.registerTool(
    'jira_list_projects',
    {
      title: 'Jira · Read — List projects',
      description:
        'List the Jira projects you can see, with their keys. Every tool that takes a projectKey ' +
        'wants one of these. Covers software, business and service-desk projects alike — a JSM ' +
        'project is a Jira project, so there is no need to go via jsm_list_service_desks to find ' +
        'a key.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe('Substring filter on project name or key, e.g. "eng" (optional)')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_projects invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const max = typeof args.max === 'number' ? args.max : 50;
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const params = [`maxResults=${max}`, 'orderBy=key'];
        if (query) params.push(`query=${encodeURIComponent(query)}`);
        const response = await auth.fetch(
          granularJiraScopes('jira_list_projects', true),
          `/rest/api/3/project/search?${params.join('&')}`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));
        const data = (await response.json()) as any;
        const projects = Array.isArray(data?.values) ? data.values : [];
        if (projects.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: query ? `No projects match "${query}".` : 'No projects visible to you.',
              },
            ],
          };
        }
        const lines = projects.map(
          (project: any) =>
            `• ${project.name} — key: ${project.key}` +
            (project.projectTypeKey ? ` — ${project.projectTypeKey}` : '')
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                [`${projects.length} project(s):`, ...lines].join('\n'),
                'a table (Name, Key, Type) usually scans faster than this flat list.'
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_list_components
  server.registerTool(
    'jira_list_components',
    {
      title: 'Jira · Read — List components in a project',
      description: 'List components in a Jira project.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_components invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey } = args;

        if (!projectKey) {
          return {
            content: [{ type: 'text' as const, text: 'projectKey is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_list_components', true),
          `/rest/api/3/project/${projectKey}/components`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const components = Array.isArray(data) ? data : data.values || [];

        const lines = [
          `Project ${projectKey} has ${components.length} components:`,
          ...components.map((c: any) => `• ${c.name} (ID: ${c.id})`),
        ];

        if (components.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Component, Lead, id) usually scans faster than this flat list.'
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_list_fields
  server.registerTool(
    'jira_list_fields',
    {
      title: 'Jira · Read — List all issue fields (standard and custom)',
      description:
        'List all fields available in a Jira project. Pass an array of filters to look up ' +
        'several field groups in one call — the whole field list is fetched and filtered ' +
        'here, so extra filters cost nothing beyond the first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM (optional)').optional(),
        query: z
          .union([z.string(), z.array(z.string())])
          .describe(
            'Substring filter on field name or id, e.g. "change" (optional). An array reports ' +
              'each filter separately, e.g. ["Project Health", "Risk", "Story Points"].'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_fields invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const response = await auth.fetch(
          granularJiraScopes('jira_list_fields', true),
          '/rest/api/3/field'
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const fields = (await response.json()) as any[];

        // 378 fields on a real site makes unfiltered paging blind — a
        // substring filter turns this into a usable lookup.
        const requested = Array.isArray(args.query) ? args.query : [args.query];
        const queries: string[] = [];
        const seen = new Set<string>();
        for (const entry of requested) {
          const text = typeof entry === 'string' ? entry.trim() : '';
          if (!text) continue;
          const key = text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          queries.push(text);
        }

        const matches = (query: string) => {
          const needle = query.toLowerCase();
          return fields.filter(
            (f: any) =>
              String(f.name ?? '')
                .toLowerCase()
                .includes(needle) ||
              String(f.id ?? '')
                .toLowerCase()
                .includes(needle)
          );
        };

        const render = (found: any[]) => [
          ...found
            .slice(0, 50)
            .map((f: any) => `• ${f.name} (${f.id}) - ${f.schema?.type || 'unknown'}`),
          found.length > 50 ? `... and ${found.length - 50} more` : '',
        ];

        const hint =
          'a table (Field name, id, Type) usually scans faster than this flat list — ' +
          'there can be dozens of custom fields.';

        // No filter, or one: the original shape, unchanged.
        if (queries.length <= 1) {
          const query = queries[0];
          const matching = query ? matches(query) : fields;
          const lines = [
            query
              ? `${matching.length} of ${fields.length} fields match "${query}":`
              : `Found ${fields.length} fields:`,
            ...render(matching),
          ];
          const text = lines.filter(Boolean).join('\n');

          if (matching.length === 0) {
            return { content: [{ type: 'text' as const, text }] };
          }
          return {
            content: [{ type: 'text' as const, text: withPresentationHint(text, hint) }],
          };
        }

        // Several filters: one section each, so a caller reading back the
        // answer can tell which field came from which question.
        const sections = queries.map((query) => {
          const found = matches(query);
          if (found.length === 0) return `"${query}" — no match`;
          return [
            `"${query}" — ${found.length} ${found.length === 1 ? 'match' : 'matches'}:`,
            ...render(found),
          ]
            .filter(Boolean)
            .join('\n');
        });

        const text = [
          `${fields.length} fields on this site, matched against ${queries.length} filters:`,
          '',
          sections.join('\n\n'),
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: withPresentationHint(text, hint) }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_search_users
  server.registerTool(
    'jira_search_users',
    {
      title: 'Jira · Read — Search Jira users by name or email',
      description:
        'Search for Jira users by email or name. Pass an array to look several people up in ' +
        'one call — resolving the attendees of a meeting or the reviewers on a change should ' +
        'not cost one round trip per person.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .union([z.string(), z.array(z.string())])
          .describe(
            'Email or name to search for. An array looks up each entry separately and reports ' +
              'the matches under that entry, e.g. ["amanda@nems.org", "Dana Lin"].'
          ),
        maxResults: z
          .number()
          .describe('Maximum results per person searched for (1-50, default 10)')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_search_users invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { query, maxResults = 10 } = args;
        const limit = Math.min(Math.max(Number(maxResults) || 10, 1), 50);

        // The same person named twice — "amanda@nems.org" in a list that also
        // carries "Amanda@nems.org" — is one search, not two.
        const requested = Array.isArray(query) ? query : [query];
        const queries: string[] = [];
        const seen = new Set<string>();
        for (const entry of requested) {
          const text = typeof entry === 'string' ? entry.trim() : '';
          if (!text) continue;
          const key = text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          queries.push(text);
        }

        if (queries.length === 0) {
          return errText('query is required');
        }
        if (queries.length > MAX_USER_QUERIES) {
          return errText(
            `too many names at once: ${queries.length} given, ${MAX_USER_QUERIES} is the limit — ` +
              'split the list across calls.'
          );
        }

        const results = await mapWithLimit(queries, USER_SEARCH_CONCURRENCY, (one) =>
          searchUsersOnce(auth, one, limit)
        );

        // One name keeps the original shape: a bare list, and an outright
        // error when the search itself failed. Callers that have always
        // passed a string see nothing new.
        if (results.length === 1) {
          const only = results[0];
          if (!only.ok) return errText(only.reason);
          const lines = [
            `Found ${only.users.length} users:`,
            ...only.users.map(
              (u: any) => `• ${u.displayName} (${u.emailAddress}) - ${u.accountId}`
            ),
          ];
          if (only.users.length === 0) {
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: withPresentationHint(
                  lines.join('\n'),
                  'a table (Name, Email, Account id) usually scans faster than this flat list.'
                ),
              },
            ],
          };
        }

        // A batch reports per name. One name failing must not lose the
        // matches found for the others — the caller can retry that one.
        const blocks = results.map((result) => {
          if (!result.ok) return `${result.query} — search failed: ${result.reason}`;
          if (result.users.length === 0) return `${result.query} — no match`;
          return [
            `${result.query} — ${result.users.length} ${result.users.length === 1 ? 'match' : 'matches'}:`,
            ...result.users.map(
              (u: any) => `• ${u.displayName} (${u.emailAddress}) - ${u.accountId}`
            ),
          ].join('\n');
        });

        const found = results.reduce((total, r) => total + (r.ok ? r.users.length : 0), 0);
        const body = [
          `Searched for ${results.length} people, found ${found} users:`,
          '',
          blocks.join('\n\n'),
        ].join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                body,
                'a table (Searched for, Name, Email, Account id) usually scans faster than ' +
                  'these grouped lists.'
              ),
            },
          ],
          // Only a wholly failed batch is an error; a partial one carries
          // results worth reading.
          ...(results.every((r) => !r.ok) ? { isError: true as const } : {}),
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_list_transitions
  server.registerTool(
    'jira_list_transitions',
    {
      title: 'Jira · Read — List available Jira transitions',
      description: 'List available transitions for an issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_transitions invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_list_transitions', true),
          `/rest/api/3/issue/${issueKey}/transitions`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const transitions = data.transitions || [];

        const lines = [
          `${issueKey} has ${transitions.length} available transitions:`,
          ...transitions.map((t: any) => `• ${t.name}`),
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );
}
