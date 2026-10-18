/**
 * The trigger half of drafting: how the drafting prompt teaches the model
 * the trigger vocabulary (the event catalog, schedule rules, chained and
 * API triggers), and how a proposed trigger off the wire becomes a real
 * TriggerDraft — or quotable feedback, never a trigger the save would
 * bounce. Split out of the drafting module so the prompt and the parser
 * that must agree live side by side.
 */

import { z } from 'zod';
import {
  MAX_SCHEDULE_RULES,
  TRIGGER_EVENT_CATALOG,
  isValidTimezone,
  normalizeMatchForEvent,
  triggerEventById,
  validateMatchForEvent,
  type Recurrence,
  type TriggerDraft,
  type Weekday,
} from '@renkei/agents';

/** Another agent the caller owns, offered as an agent-finished trigger target. */
export interface AgentOption {
  id: string;
  name: string;
}

/**
 * Present when the builder has NO triggers yet and wants the draft to
 * propose them from the prose — and only then: with triggers already
 * configured, proposing more would duplicate what the user set up.
 */
export interface TriggerOffer {
  otherAgents: AgentOption[];
}

/** Where a parse records what went wrong, for the model's corrective round. */
export interface TriggerParseState {
  softProblems: string[];
}

/** The prompt lines that teach the trigger vocabulary. */
export function triggerPromptLines(triggerOffer: TriggerOffer): string[] {
  return [
    'Triggers — WHEN the automation runs. Include a "triggers" array (at most 3 entries) ' +
      'ONLY when the description clearly states when it runs ("every weekday at 9", "when ' +
      'a message is posted", "when called from our script"). If it does not clearly state ' +
      'one, OMIT the field entirely — never invent or guess a trigger. Each entry is one of:',
    '  {"kind": "schedule", "rules": array of 1-' +
      `${MAX_SCHEDULE_RULES}, "timezone": IANA zone ONLY when the ` +
      'description names one, else null}. Each rule: {"every": "hour"} | {"every": "day", ' +
      '"at": "HH:MM"} | {"every": "weekday", "at": "HH:MM"} (weekday = Monday-Friday) | ' +
      '{"every": "week", "weekday": 0-6 (0 = Sunday), "at": "HH:MM"} | {"every": "month", ' +
      '"day": 1-31, "at": "HH:MM"}. Times are 24-hour.',
    '  {"kind": "event", "eventId": one of EXACTLY these ids, "match": OPTIONAL filters}:',
    ...TRIGGER_EVENT_CATALOG.flatMap((event) => [
      `    - ${event.id}: ${event.label} — ${event.description}`,
      ...event.filters.flatMap((field) => [
        `        match.${field.id}: ${
          field.input === 'select'
            ? `EXACTLY one of ${(field.options ?? [])
                .filter((option) => option.value)
                .map((option) => `"${option.value}"`)
                .join(' | ')}`
            : field.input === 'text'
              ? 'one string'
              : 'a list of strings'
        } — ${field.label.toLowerCase()}. ${field.hint}`,
        // Taught explicitly rather than left to be guessed: the
        // default is the permissive one, so the only way to get ALL
        // wrong is to write it when the user did not ask for it.
        ...(field.modeKey
          ? [
              `        match.${field.modeKey}: "all" ONLY when the description says every ` +
                `one of them must appear ("mentions both X and Y"). Omit it otherwise — ` +
                `any one of them matching is the default.`,
            ]
          : []),
      ]),
    ]),
    // The filters are deterministic and cheap, so a stated one is
    // worth capturing — but an INVENTED one silently stops an agent
    // firing, and nothing downstream ever reports why. Guessing here
    // is strictly worse than omitting.
    '  Include "match" ONLY for a narrowing the description states outright ("emails from ' +
      'billing@acme.com", "messages in the #support space"). Never infer one from context, ' +
      'never guess an address or an id, and omit "match" entirely when in doubt. A filter ' +
      'the user did not ask for makes the automation silently never run.',
    ...(triggerOffer.otherAgents.length > 0
      ? [
          '  {"kind": "agent", "agentName": EXACTLY one of the user\'s other automations} — ' +
            'runs after that automation finishes. Their names: ' +
            triggerOffer.otherAgents.map((agent) => `"${agent.name}"`).join(', ') +
            '.',
        ]
      : []),
    '  {"kind": "api", "inputs": array of {"name": short input name, "label": short ' +
      'label}} — an external caller starts the automation over the API, passing these ' +
      'inputs (they become trigger.<name> variables).',
  ];
}

export function zodProblems(prefix: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) =>
      `${prefix}${issue.path.length > 0 ? `"${issue.path.join('.')}" ` : ''}${issue.message}`
  );
}

export function sanitizeSaveAs(raw: string): string {
  let name = raw
    .trim()
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^[^A-Za-z]+/, '');
  return name.slice(0, 64).trim();
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const SCHEDULE_RULE_SHAPE = z.object({
  every: z.enum(['hour', 'day', 'weekday', 'week', 'month']),
  at: z.string().nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  day: z.number().int().min(1).max(31).nullable().optional(),
});

const SCHEDULE_TRIGGER_SHAPE = z.object({
  kind: z.literal('schedule'),
  rules: z.array(z.unknown()).min(1, 'needs at least one rule').max(MAX_SCHEDULE_RULES),
  timezone: z.string().nullable().optional(),
});

const EVENT_TRIGGER_SHAPE = z.object({
  kind: z.literal('event'),
  eventId: z.string().min(1, 'is required'),
  /**
   * Deterministic filters. Loosely typed here on purpose — the legal field
   * ids are catalog data that varies per event, so the shape gate is
   * structural and `normalizeMatchForEvent` does the real narrowing.
   */
  match: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});

const AGENT_TRIGGER_SHAPE = z.object({
  kind: z.literal('agent'),
  agentName: z.string().min(1, 'is required'),
});

const API_TRIGGER_SHAPE = z.object({
  kind: z.literal('api'),
  inputs: z
    .array(z.object({ name: z.string().min(1), label: z.string().nullable().optional() }))
    .max(10),
});

function weekdayOf(value: number): Weekday | null {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      return value;
    default:
      return null;
  }
}

/** One schedule rule off the wire → a real Recurrence, or a diagnosis. */
function recurrenceOf(raw: unknown, label: string, state: TriggerParseState): Recurrence | null {
  const checked = SCHEDULE_RULE_SHAPE.safeParse(raw);
  if (!checked.success) {
    state.softProblems.push(...zodProblems(`${label} schedule rule: `, checked.error));
    return null;
  }
  const rule = checked.data;
  if (rule.every === 'hour') return { every: 'hour' };
  const at = typeof rule.at === 'string' ? rule.at : '';
  if (!TIME_PATTERN.test(at)) {
    state.softProblems.push(
      `${label} has a "${rule.every}" schedule rule without a valid "at" — give the time as 24-hour "HH:MM".`
    );
    return null;
  }
  switch (rule.every) {
    case 'day':
      return { every: 'day', at };
    case 'weekday':
      return { every: 'weekday', at };
    case 'week': {
      const weekday = typeof rule.weekday === 'number' ? weekdayOf(rule.weekday) : null;
      if (weekday === null) {
        state.softProblems.push(
          `${label} has a weekly schedule rule without "weekday" (0-6, 0 = Sunday).`
        );
        return null;
      }
      return { every: 'week', weekday, at };
    }
    case 'month': {
      if (typeof rule.day !== 'number') {
        state.softProblems.push(`${label} has a monthly schedule rule without "day" (1-31).`);
        return null;
      }
      return { every: 'month', day: rule.day, at };
    }
  }
}

/**
 * Parse the reply's proposed triggers. A broken entry degrades to quotable
 * feedback and is dropped — an invented event id
 * or unknown agent name must never reach the builder as a chip the save
 * would bounce. An empty result is fine: "the prose never said when" is the
 * honest answer the prompt asked for.
 */
export function parseTriggerEntries(
  entries: unknown[],
  state: TriggerParseState,
  offer: TriggerOffer
): TriggerDraft[] {
  const drafts: TriggerDraft[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `Trigger ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      state.softProblems.push(`${label} is not an object.`);
      continue;
    }
    const candidate: { kind?: unknown } = entry;
    switch (candidate.kind) {
      case 'schedule': {
        const checked = SCHEDULE_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (schedule): `, checked.error));
          break;
        }
        const recurrences = checked.data.rules.flatMap((raw) => {
          const rule = recurrenceOf(raw, label, state);
          return rule ? [rule] : [];
        });
        if (recurrences.length === 0) break;
        const given = typeof checked.data.timezone === 'string' ? checked.data.timezone : '';
        if (given && !isValidTimezone(given)) {
          state.softProblems.push(
            `${label} names the timezone "${given}", which is not a recognized IANA zone — it was dropped (the user's own timezone applies).`
          );
        }
        // '' = "the prose named none": the builder fills in the USER'S zone,
        // which this code cannot know.
        const timezone = given && isValidTimezone(given) ? given : '';
        drafts.push({ kind: 'schedule', recurrences, timezone });
        break;
      }
      case 'event': {
        const checked = EVENT_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (event): `, checked.error));
          break;
        }
        if (!triggerEventById(checked.data.eventId)) {
          state.softProblems.push(
            `${label} uses the event id "${checked.data.eventId}", which is not in the list — the legal ids are: ${TRIGGER_EVENT_CATALOG.map((event) => event.id).join(', ')}.`
          );
          break;
        }
        // A filter the model got wrong is DROPPED, not fatal. Drafting is
        // advisory — the builder is where a trigger is finished — and
        // refusing the whole draft over a mistyped address would throw away
        // the instructions too. The soft problem carries it into the next round.
        const eventId = checked.data.eventId;
        const filterProblems = validateMatchForEvent(eventId, checked.data.match);
        for (const problem of filterProblems) {
          state.softProblems.push(`${label}'s filter was dropped: ${problem}`);
        }
        const match =
          filterProblems.length > 0 ? {} : normalizeMatchForEvent(eventId, checked.data.match);
        // Omitted when empty rather than sent as {}: a draft should say only
        // what the prose said, and an empty match is indistinguishable from
        // no match to everything downstream anyway.
        drafts.push({
          kind: 'event',
          eventId,
          ...(Object.keys(match).length > 0 ? { match } : {}),
        });
        break;
      }
      case 'agent': {
        const checked = AGENT_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (agent): `, checked.error));
          break;
        }
        const wanted = checked.data.agentName.trim().toLowerCase();
        const match = offer.otherAgents.find((agent) => agent.name.trim().toLowerCase() === wanted);
        if (!match) {
          state.softProblems.push(
            offer.otherAgents.length > 0
              ? `${label} names the automation "${checked.data.agentName}", which the user does not have — their automations are: ${offer.otherAgents.map((agent) => `"${agent.name}"`).join(', ')}.`
              : `${label} is an "agent" trigger, but the user has no other automations — drop it.`
          );
          break;
        }
        drafts.push({ kind: 'agent', callerAgentId: match.id });
        break;
      }
      case 'api': {
        const checked = API_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (api): `, checked.error));
          break;
        }
        const seen = new Set<string>();
        const inputs = checked.data.inputs.flatMap((input) => {
          const name = sanitizeSaveAs(input.name);
          if (!name || seen.has(name.toLowerCase())) return [];
          seen.add(name.toLowerCase());
          return [
            {
              name,
              label:
                typeof input.label === 'string' && input.label.trim()
                  ? input.label.trim().slice(0, 80)
                  : name,
            },
          ];
        });
        drafts.push({ kind: 'api', inputs });
        break;
      }
      default:
        state.softProblems.push(
          `${label} has the kind ${JSON.stringify(candidate.kind)} — triggers are "schedule", "event", "agent", or "api".`
        );
    }
  }
  return drafts;
}
