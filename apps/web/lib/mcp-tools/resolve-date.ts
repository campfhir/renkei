/**
 * resolve_date — a chat's escape hatch from doing date arithmetic itself.
 *
 * A relative date a person types — "3 days ago", "since last Friday",
 * "9am tomorrow" — needs a calendar shift, a wall-clock set, and a
 * DST-aware zone conversion to become an actual instant, and a model that
 * works this out in its head is confidently wrong often enough that agent
 * steps get a dedicated primitive for exactly this problem: the DATE CHIP
 * (`{t:"date",...}`, packages/agents/src/steps.ts) and the step-runtime's
 * own free `resolve_time` tool (packages/agents/src/step-prompts.ts) — both
 * resolved through the same deterministic `resolveTime` (resolve-time.ts).
 * An ordinary chat is neither running inside a step nor authoring one when
 * someone just asks "what happened since Monday" — it had nothing to reach
 * for, so it either asked a connector tool to filter on a date the model
 * computed itself, or didn't bother and got the window wrong.
 *
 * This is the same arithmetic, reachable from anywhere: ungated and always
 * registered (see registry.ts — the way whoami and check_file_upload are)
 * and listed in CHAT_ALWAYS_TOOLS so every chat is offered it whatever
 * toolset it runs with. Deliberately a DIFFERENT tool name from the
 * step-runtime's `resolve_time`: that name is reserved for the in-process,
 * budget-free call the engine special-cases in every step attempt (engine.ts)
 * — a step whose own "tool" happened to collide with it would offer the
 * model two same-named tool defs in one call.
 *
 * The reply also hands back the exact date-CHIP object a caller authoring
 * an agent (agent_create, agent_update, agent_patch_steps) can paste
 * straight into a step's instruction, a branch/loop condition, retry
 * guidance or an ending's message — so asking what a relative date resolves
 * to right now and asking what to write into the step are the same call.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { resolveTime, type TimeUnit } from '@renkei/agents';
import type { MCPToolContext } from './common';

/** Mirrors TIME_UNITS (packages/agents/src/resolve-time.ts) as a zod enum —
 *  that constant is a plain readonly array, not the tuple shape z.enum needs. */
const TIME_UNIT_VALUES = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;

/** Minute and hour shifts snap to the hour; larger units to their own — the
 *  same rule render.ts's snapUnit applies to a date chip's own boundary. */
function snapUnit(unit: TimeUnit): 'hour' | 'day' | 'week' | 'month' {
  switch (unit) {
    case 'minute':
    case 'hour':
      return 'hour';
    case 'week':
      return 'week';
    case 'month':
    case 'year':
      return 'month';
    case 'day':
    default:
      return 'day';
  }
}

export function registerResolveDateTool(server: McpServer, _context: MCPToolContext): void {
  server.registerTool(
    'resolve_date',
    {
      title: 'Renkei · Read — Resolve a relative date/time',
      description:
        'Compute an exact instant from a relative description instead of working it out ' +
        'yourself — "3 days ago", "since last Friday at 9am", "the start of this month". Give ' +
        'a timezone plus a signed amount+unit (and optionally a time of day, or a snap to the ' +
        'start/end of the unit) and get back the real instant, with daylight saving and ' +
        'calendar length handled. Always available, whatever this chat\'s toolset — never ' +
        'guess or hand-calculate a date, call this instead. When authoring or editing an ' +
        'agent (agent_create, agent_update, agent_patch_steps), the reply also gives the ' +
        'exact date-chip object ({"t":"date",...}) to paste directly into a step\'s ' +
        'instruction, a branch/loop condition, retry guidance or an ending\'s message — it ' +
        'resolves the same way, fresh, every time that run fires.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        timezone: z
          .string()
          .min(1)
          .describe(
            'IANA zone the times are read and written in, e.g. "America/Los_Angeles", "UTC" ' +
              '— use the zone the request is phrased in, not your own.'
          ),
        amount: z
          .number()
          .int()
          .optional()
          .describe(
            'How far to move, signed: -1 with unit "day" is yesterday, 2 with "week" is a ' +
              'fortnight from now. Omit for "today"/"now". Needs a unit.'
          ),
        unit: z
          .enum(TIME_UNIT_VALUES)
          .optional()
          .describe(
            'The unit for amount. minute/hour are exact elapsed time; day and larger keep the ' +
              'same wall-clock time across a daylight-saving change.'
          ),
        atTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '24-hour "HH:MM", e.g. "19:00"')
          .optional()
          .describe('Time of day in `timezone`, 24-hour "HH:MM" — applied after the shift.'),
        boundary: z
          .enum(['start', 'end'])
          .optional()
          .describe(
            'Snap to the start or end of `unit` (e.g. "the start of today"). Ignored when ' +
              'atTime is given.'
          ),
        anchor: z
          .string()
          .optional()
          .describe('What to measure from: "now" (default) or an ISO 8601 instant.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : '';
      const amount = typeof args.amount === 'number' ? args.amount : undefined;
      const unit = typeof args.unit === 'string' ? (args.unit as TimeUnit) : undefined;
      const atTime = typeof args.atTime === 'string' ? args.atTime : undefined;
      const boundary =
        args.boundary === 'start' || args.boundary === 'end' ? args.boundary : undefined;
      const anchor = typeof args.anchor === 'string' ? args.anchor : undefined;

      if (amount !== undefined && unit === undefined) {
        return {
          content: [
            { type: 'text' as const, text: 'An amount needs a unit (e.g. amount: -1, unit: "day").' },
          ],
          isError: true,
        };
      }

      const resolved = resolveTime({
        timezone,
        ...(anchor !== undefined ? { anchor } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(atTime !== undefined ? { atTime } : {}),
        ...(boundary === 'start' && unit !== undefined ? { startOf: snapUnit(unit) } : {}),
        ...(boundary === 'end' && unit !== undefined ? { endOf: snapUnit(unit) } : {}),
      });
      if (!resolved.ok) {
        return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
      }

      // The chip an agent-authoring caller can paste verbatim — the same
      // fields this call itself took, minus the ones a chip has no use for.
      const chip = {
        t: 'date',
        amount: amount ?? 0,
        unit: unit ?? 'day',
        timezone,
        ...(atTime !== undefined ? { atTime } : {}),
        ...(boundary !== undefined ? { boundary } : {}),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `${resolved.value.iso} (UTC) — reads as ${resolved.value.local} in ${timezone}.`,
              `Date-chip for an agent step: ${JSON.stringify(chip)}`,
            ].join('\n'),
          },
        ],
      };
    }
  );
}
