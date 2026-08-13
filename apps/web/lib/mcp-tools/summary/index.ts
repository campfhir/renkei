/**
 * `daily_summary` — one call that gathers every connected surface for a
 * period, plus a `<connector>_summary` tool per provider.
 *
 * The orchestrator holds no connector knowledge. It is handed the providers
 * this caller actually has (the MCP route already computed availability for
 * tool registration, so the same booleans decide this) and loops. Adding a
 * connector to the summary is adding a collector and one line in the route —
 * which is the scalability the per-connector shape buys.
 *
 * Providers run CONCURRENTLY and a failing one costs only its own section.
 * A morning summary that returns nothing because Confluence is down is worse
 * than one that returns everything else and says Confluence is down.
 *
 * Renkei writes no prose here — see types.ts. The output is material; the
 * calling model is the summarizer.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import { textResult, errText } from '../graph/client';
import { resolvePeriod, PERIOD_PRESETS } from './period';
import { renderSection, type SummaryProvider, type SummarySection } from './types';

export { resolvePeriod, PERIOD_PRESETS } from './period';
export type { SummaryProvider, SummaryCollector, SummarySection, SummaryPeriod } from './types';

/** The connector key the summary tools themselves register under. */
export const SUMMARY_CONNECTOR = 'summary';

const periodSchema = {
  period: z.enum(PERIOD_PRESETS).describe('Which window to summarize (default today).').optional(),
  after: z.string().describe('ISO-8601 start, overriding `period`.').optional(),
  before: z.string().describe('ISO-8601 end, overriding `period`.').optional(),
  timeZone: z
    .string()
    .describe('IANA zone the day boundaries are computed in, e.g. Europe/London. Defaults to UTC.')
    .optional(),
};

function periodFrom(args: Record<string, unknown>) {
  return resolvePeriod({
    period: typeof args.period === 'string' ? args.period : undefined,
    after: typeof args.after === 'string' ? args.after : undefined,
    before: typeof args.before === 'string' ? args.before : undefined,
    timeZone: typeof args.timeZone === 'string' ? args.timeZone : undefined,
  });
}

export function registerSummaryTools(
  server: McpServer,
  context: MCPToolContext,
  providers: SummaryProvider[]
): void {
  if (providers.length === 0) return;

  server.registerTool(
    'daily_summary',
    {
      title: 'Renkei · Read — Summarize the day across every connected tool',
      description:
        'Gathers what happened in a period across everything this user has connected — calendar, ' +
        'unread mail, the current sprint, changed documents, chat and meeting notes — and returns ' +
        'it as structured material to summarize. Sources the user has not connected are simply ' +
        'absent. Counts are exact; lists and previews may be truncated, and any section that was ' +
        'cut says so — do not describe a truncated list as the whole.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        ...periodSchema,
        only: z
          .array(z.string())
          .describe('Restrict to these connectors, e.g. ["jira","microsoft"].')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const period = periodFrom(args);
      const only = Array.isArray(args.only) ? new Set(args.only.map(String)) : null;
      const selected = only
        ? providers.filter((provider) => only.has(provider.connector))
        : providers;

      if (selected.length === 0) {
        return errText(
          `None of those connectors are available to you. Connected: ${[
            ...new Set(providers.map((provider) => provider.connector)),
          ].join(', ')}.`
        );
      }

      // Concurrently, and each guarded: one connector failing must not take
      // the summary with it.
      const settled = await Promise.all(
        selected.map(async (provider): Promise<SummarySection | null> => {
          try {
            return await provider.collect(context, period);
          } catch {
            return {
              connector: provider.connector,
              label: provider.label,
              lines: [],
              omitted: 'this source could not be read for the period',
            };
          }
        })
      );

      const sections = settled.filter((section): section is SummarySection => section !== null);
      const header =
        `Summary for ${period.label} (${period.start.slice(0, 10)} → ${period.end.slice(0, 10)}, ` +
        `${period.timeZone})`;

      if (sections.length === 0) {
        return textResult(`${header}\n\nNothing to report from any connected source.`);
      }

      const quiet = selected
        .filter((provider) => !sections.some((section) => section.connector === provider.connector))
        .map((provider) => provider.label);

      return textResult(
        withPresentationHint(
          [
            header,
            ...sections.map(renderSection),
            quiet.length > 0 ? `\nNothing to report from: ${quiet.join(', ')}.` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          'Write this up as a short brief for the user. Lead with anything time-critical ' +
            '(meetings starting soon, high-importance mail). Cross-reference across sources where ' +
            'they clearly relate. Respect any note saying a list was truncated.'
        )
      );
    }
  );

  // The same collectors, individually. Someone who only wants their sprint
  // should not pay for a mailbox round trip to get it.
  for (const provider of providers) {
    server.registerTool(
      provider.toolName,
      {
        title: `${provider.label} · Read — Summarize ${provider.label.toLowerCase()} for a period`,
        description:
          `Just the ${provider.label.toLowerCase()} part of daily_summary, as structured ` +
          'material to summarize. Use daily_summary when the ask spans more than one source.',
        annotations: { readOnlyHint: true },
        inputSchema: z.object(periodSchema),
      },
      async (args: Record<string, unknown>) => {
        const period = periodFrom(args);
        let section: SummarySection | null;
        try {
          section = await provider.collect(context, period);
        } catch {
          return errText(`Could not read ${provider.label.toLowerCase()} for ${period.label}.`);
        }
        if (!section) {
          return textResult(
            `Nothing to report from ${provider.label.toLowerCase()} for ${period.label}.`
          );
        }
        return textResult(
          withPresentationHint(
            `Summary for ${period.label} (${period.timeZone})\n\n${renderSection(section)}`,
            'Write this up as a short brief. Respect any note saying a list was truncated.'
          )
        );
      }
    );
  }
}
