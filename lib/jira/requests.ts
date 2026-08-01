/**
 * Rendering for Jira Service Management customer requests.
 *
 * The same concern as ./issues.ts, with a different payload shape. JSM
 * responses are considerably noisier than platform ones — every object carries
 * `_links`, `_expands`, and four avatar URLs at three sizes — so almost all of
 * the work here is deciding what *not* to pass on.
 *
 * Two JSM-specific quirks the shapes below were checked against on a live
 * tenant:
 *
 *   - Dates arrive as `{iso8601, jira, friendly, epochMillis}`, not strings.
 *   - Comment bodies are plain text, not ADF. The platform API and the JSM API
 *     disagree about this, so no ADF conversion happens on this path.
 */

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * JSM wraps every timestamp in an object; `iso8601` is the machine-readable
 * one. `friendly` is deliberately ignored: it renders as "Today 4:41 PM" in
 * the *reporting* user's timezone, which is not the reader's.
 *
 * The result is UTC and says so. A live tenant returned an SLA breaching at
 * `16:41-0700`, which normalizes to `23:41` — a bare "23:41" read as local
 * time is a seven-hour error on a deadline, which is the whole thing
 * get_request_sla is supposed to get right.
 */
function jsmDate(value: unknown): string | null {
  const iso = text(record(value).iso8601);
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed)
    ? iso
    : `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// ------------------------------------------------------------ service desks

export interface ServiceDesk {
  id: string;
  projectKey: string;
  projectName: string;
}

export function toServiceDesks(raw: unknown): ServiceDesk[] {
  return list(record(raw).values).map((entry) => {
    const desk = record(entry);
    return {
      id: text(desk.id) ?? '(unknown)',
      projectKey: text(desk.projectKey) ?? '(unknown)',
      projectName: text(desk.projectName) ?? '(unnamed)',
    };
  });
}

export function formatServiceDesks(desks: readonly ServiceDesk[]): string {
  if (desks.length === 0) {
    return 'No service desks are visible to this account.';
  }

  const lines = desks.map(
    (desk) => `- **${desk.projectName}** (${desk.projectKey}) — service desk id \`${desk.id}\``,
  );
  return [`${desks.length} service desk(s):`, '', ...lines].join('\n');
}

// ------------------------------------------------------------ request types

export interface RequestType {
  id: string;
  name: string;
  description: string | null;
  helpText: string | null;
  issueTypeId: string | null;
  canCreate: boolean;
}

export function toRequestTypes(raw: unknown): RequestType[] {
  return list(record(raw).values).map((entry) => {
    const type = record(entry);
    return {
      id: text(type.id) ?? '(unknown)',
      name: text(type.name) ?? '(unnamed)',
      description: text(type.description),
      helpText: text(type.helpText),
      issueTypeId: text(type.issueTypeId),
      canCreate: type.canCreateRequest !== false,
    };
  });
}

export function formatRequestTypes(deskId: string, types: readonly RequestType[]): string {
  if (types.length === 0) {
    return `Service desk ${deskId} exposes no request types to this account.`;
  }

  const lines = types.map((type) => {
    const flag = type.canCreate ? '' : ' _(cannot be raised by this account)_';
    const parts = [`- \`${type.id}\` **${type.name}**`];

    if (type.description !== null) {
      parts.push(` — ${type.description}`);
    }

    if (type.helpText !== null) {
      parts.push(` · _{${type.helpText}}_`);
    }

    parts.push(flag);

    return parts.join('');
  });

  return [`Request types in service desk ${deskId}:`, '', ...lines].join('\n');
}

export interface RequestTypeField {
  fieldId: string;
  name: string;
  required: boolean;
  type: string | null;
  validValues: string[];
}

export function toRequestTypeFields(raw: unknown): RequestTypeField[] {
  return list(record(raw).requestTypeFields).map((entry) => {
    const field = record(entry);
    return {
      fieldId: text(field.fieldId) ?? '(unknown)',
      name: text(field.name) ?? '(unnamed)',
      required: field.required === true,
      type: text(record(field.jiraSchema).type),
      validValues: list(field.validValues)
        .map((value) => text(record(value).label) ?? text(record(value).value))
        .filter((value): value is string => value !== null),
    };
  });
}

export function formatRequestTypeFields(fields: readonly RequestTypeField[]): string {
  if (fields.length === 0) {
    return 'This request type exposes no fields.';
  }

  const lines = fields.map((field) => {
    const parts = [`- \`${field.fieldId}\` **${field.name}**`];
    parts.push(field.required ? ' _(required)_' : ' _(optional)_');
    if (field.type !== null) parts.push(` · ${field.type}`);
    if (field.validValues.length > 0) {
      // Capped: a country or component picker can carry hundreds of options,
      // and the full list is rarely what the caller needs to choose.
      const shown = field.validValues.slice(0, 20);
      const more = field.validValues.length - shown.length;
      parts.push(`\n  allowed: ${shown.join(', ')}${more > 0 ? ` … and ${more} more` : ''}`);
    }
    return parts.join('');
  });

  return ['Fields for this request type:', '', ...lines].join('\n');
}

// ---------------------------------------------------------------- requests

export interface RequestSummary {
  key: string;
  summary: string;
  status: string | null;
  created: string | null;
  reporter: string | null;
  requestTypeId: string | null;
  serviceDeskId: string | null;
}

export function toRequestSummary(raw: unknown): RequestSummary {
  const request = record(raw);
  return {
    key: text(request.issueKey) ?? '(unknown)',
    summary: text(request.summary) ?? '(no summary)',
    status: text(record(request.currentStatus).status),
    created: jsmDate(request.createdDate),
    reporter: text(record(request.reporter).displayName),
    requestTypeId: text(request.requestTypeId),
    serviceDeskId: text(request.serviceDeskId),
  };
}

export function toRequestSummaries(raw: unknown): RequestSummary[] {
  return list(record(raw).values).map(toRequestSummary);
}

export function formatRequestList(requests: readonly RequestSummary[]): string {
  if (requests.length === 0) {
    return 'No customer requests are visible to this account.';
  }

  const lines = requests.flatMap((request) => [
    `**${request.key}** — ${request.summary}`,
    `  status: ${request.status ?? 'unknown'}` +
      (request.reporter === null ? '' : ` · reporter: ${request.reporter}`) +
      (request.created === null ? '' : ` · created: ${request.created}`),
  ]);

  return [`${requests.length} request(s):`, '', ...lines].join('\n');
}

export interface RequestComment {
  author: string;
  created: string | null;
  public: boolean;
  body: string;
}

export function toRequestComments(raw: unknown): RequestComment[] {
  return list(record(raw).values).map((entry) => {
    const comment = record(entry);
    return {
      author: text(record(comment.author).displayName) ?? 'unknown',
      created: jsmDate(comment.created),
      // Absent `public` is treated as internal: under-sharing a comment in the
      // rendering is safer than labelling an internal note as customer-visible.
      public: comment.public === true,
      body: text(comment.body) ?? '',
    };
  });
}

export function formatRequestDetail(
  raw: unknown,
  comments: readonly RequestComment[],
  options: { maxComments: number },
): string {
  const request = record(raw);
  const summary = toRequestSummary(request);

  const sections: string[] = [`# ${summary.key} — ${summary.summary}`, ''];

  const facts = [
    `- status: ${summary.status ?? 'unknown'}`,
    `- reporter: ${summary.reporter ?? 'unknown'}`,
    `- created: ${summary.created ?? 'unknown'}`,
  ];

  const requestType = text(record(request.requestType).name);
  if (requestType !== null) facts.push(`- request type: ${requestType}`);
  const desk = text(record(request.serviceDesk).projectName);
  if (desk !== null) facts.push(`- service desk: ${desk}`);

  sections.push(...facts, '');

  // requestFieldValues carries the portal form the customer filled in. Summary
  // is already the heading, so it is not repeated.
  const values = list(request.requestFieldValues)
    .map((entry) => record(entry))
    .filter((field) => text(field.fieldId) !== 'summary');

  for (const field of values) {
    const label = text(field.label) ?? text(field.fieldId) ?? 'Field';
    const value = renderFieldValue(field.value);
    if (value !== null) {
      sections.push(`## ${label}`, '', value, '');
    }
  }

  if (comments.length > 0) {
    const shown = comments.slice(-options.maxComments);
    const omitted = comments.length - shown.length;
    sections.push(`## Comments (${shown.length} of ${comments.length})`, '');
    if (omitted > 0) {
      sections.push(`_${omitted} older comment(s) omitted._`, '');
    }
    for (const comment of shown) {
      const visibility = comment.public ? 'customer-visible' : 'internal';
      sections.push(
        `**${comment.author}** · ${comment.created ?? 'unknown'} · _${visibility}_`,
        '',
        comment.body,
        '',
      );
    }
  }

  return sections.join('\n').trim();
}

/**
 * Portal field values are loosely typed: a string for text fields, an object
 * with `value`/`name` for pickers, an array for multi-selects. Anything else
 * is dropped rather than stringified, because `[object Object]` in an issue
 * body is worse than an absent field.
 */
function renderFieldValue(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(renderFieldValue).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  const object = record(value);
  return text(object.value) ?? text(object.name) ?? text(object.displayName);
}

// ------------------------------------------------------- transitions/approvals

export interface RequestTransition {
  id: string;
  name: string;
}

export function toRequestTransitions(raw: unknown): RequestTransition[] {
  return list(record(raw).values).map((entry) => {
    const transition = record(entry);
    return {
      id: text(transition.id) ?? '(unknown)',
      name: text(transition.name) ?? '(unnamed)',
    };
  });
}

export function formatRequestTransitions(
  key: string,
  transitions: readonly RequestTransition[],
): string {
  if (transitions.length === 0) {
    return `No customer transitions are available on ${key}. The request may be closed, or its workflow may expose none through the portal.`;
  }

  const lines = transitions.map((transition) => `- \`${transition.id}\` ${transition.name}`);
  return [`Available transitions for ${key}:`, '', ...lines].join('\n');
}

export interface RequestApproval {
  id: string;
  name: string;
  decision: string | null;
  approvers: string[];
}

export function toRequestApprovals(raw: unknown): RequestApproval[] {
  return list(record(raw).values).map((entry) => {
    const approval = record(entry);
    return {
      id: text(approval.id) ?? '(unknown)',
      name: text(approval.name) ?? '(unnamed)',
      decision: text(approval.finalDecision),
      approvers: list(approval.approvers)
        .map((approver) => text(record(record(approver).approver).displayName))
        .filter((name): name is string => name !== null),
    };
  });
}

export function formatRequestApprovals(key: string, approvals: readonly RequestApproval[]): string {
  if (approvals.length === 0) {
    return `${key} has no approvals.`;
  }

  const lines = approvals.map((approval) => {
    const approvers = approval.approvers.length > 0 ? ` · ${approval.approvers.join(', ')}` : '';
    return `- \`${approval.id}\` **${approval.name}** — ${approval.decision ?? 'pending'}${approvers}`;
  });

  return [
    `Approvals on ${key}:`,
    '',
    ...lines,
    '',
    '_Renkei can read approvals but cannot decide them — see README Phase 3.5._',
  ].join('\n');
}

// --------------------------------------------------------------------- SLAs

/**
 * SLA state for a request.
 *
 * The thing that makes this worth rendering carefully rather than dumping is
 * that **an SLA clock is not wall-clock time.** It runs against a working
 * calendar and it can be paused by the workflow, so "3h remaining" can mean
 * "breaches at 11:00 tomorrow" on a Friday afternoon. Atlassian computes the
 * real deadline itself and returns it as `breachTime`, so that is what gets
 * the emphasis here; the remaining duration is shown next to it, labelled as
 * working time rather than left to be read as an hours-from-now countdown.
 *
 * Durations are formatted from `millis` rather than passed through as the
 * `friendly` string Atlassian also supplies. `friendly` is localized to the
 * caller and formats a negative remainder inconsistently, and a breach that
 * reads as `-11h` in one tenant and `11h ago` in another is exactly the sort
 * of thing a model paraphrases wrongly.
 *
 * Two things observed on a live tenant that the shape below allows for:
 *
 *   - A metric can exist with neither an ongoing nor a completed cycle. The
 *     clock is configured but its start condition has not fired, which is not
 *     the same as the project having no SLAs at all.
 *   - `slaDisplayFormat` came back as `NEW_SLA_FORMAT`, which is not one of
 *     the documented values. Nothing here reads it.
 */

/** Duration objects are `{millis, friendly}`; only millis is dependable. */
function millis(value: unknown): number | null {
  const raw = record(value).millis;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export interface SlaCycle {
  breached: boolean;
  goalMillis: number | null;
  elapsedMillis: number | null;
  remainingMillis: number | null;
  startTime: string | null;
  stopTime: string | null;
  breachTime: string | null;
}

export interface RequestSla {
  id: string;
  name: string;
  /** The cycle currently running, if the clock is started. */
  ongoing: (SlaCycle & { paused: boolean; withinCalendarHours: boolean }) | null;
  /** Finished cycles, oldest first. More than one means the request was reopened. */
  completed: SlaCycle[];
}

function toCycle(raw: unknown): SlaCycle {
  const cycle = record(raw);
  return {
    breached: cycle.breached === true,
    goalMillis: millis(cycle.goalDuration),
    elapsedMillis: millis(cycle.elapsedTime),
    remainingMillis: millis(cycle.remainingTime),
    startTime: jsmDate(cycle.startTime),
    stopTime: jsmDate(cycle.stopTime),
    breachTime: jsmDate(cycle.breachTime),
  };
}

export function toRequestSlas(raw: unknown): RequestSla[] {
  return list(record(raw).values).map((entry) => {
    const sla = record(entry);
    const ongoing = record(sla.ongoingCycle);

    return {
      id: text(sla.id) ?? '(unknown)',
      name: text(sla.name) ?? '(unnamed)',
      ongoing:
        sla.ongoingCycle === undefined || sla.ongoingCycle === null
          ? null
          : {
              ...toCycle(ongoing),
              paused: ongoing.paused === true,
              // Absent means the field was not returned, not that the clock is
              // stopped; treating it as "inside hours" avoids a caveat on every
              // SLA of every tenant that does not use a working calendar.
              withinCalendarHours: ongoing.withinCalendarHours !== false,
            },
      completed: list(sla.completedCycles).map(toCycle),
    };
  });
}

/** `3h 55m`, `2d 4h`, `45s`. Always positive — sign is the caller's to phrase. */
export function formatDuration(totalMillis: number): string {
  const seconds = Math.floor(Math.abs(totalMillis) / 1000);
  const units: [number, string][] = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];

  const parts: string[] = [];
  let rest = seconds;
  for (const [size, suffix] of units) {
    const amount = Math.floor(rest / size);
    if (amount > 0) parts.push(`${amount}${suffix}`);
    rest -= amount * size;
    // Two units is enough to act on; `2d 4h 13m 9s` is noise.
    if (parts.length === 2) break;
  }

  if (parts.length === 0) return `${seconds}s`;
  return parts.join(' ');
}

function describeOngoing(ongoing: NonNullable<RequestSla['ongoing']>): string[] {
  const remaining = ongoing.remainingMillis;
  const state = (() => {
    if (ongoing.breached || (remaining !== null && remaining < 0)) {
      return remaining === null
        ? '**BREACHED**'
        : `**BREACHED** by ${formatDuration(remaining)} of working time`;
    }
    if (remaining === null) return 'running';
    const left = `${formatDuration(remaining)} of working time left`;
    return ongoing.paused ? `paused — ${left} when it resumes` : `running — ${left}`;
  })();

  const lines = [state];

  const facts: string[] = [];
  if (ongoing.breachTime !== null) {
    facts.push(`${ongoing.breached ? 'breached at' : 'breaches at'} ${ongoing.breachTime}`);
  }
  if (ongoing.goalMillis !== null) facts.push(`goal ${formatDuration(ongoing.goalMillis)}`);
  if (ongoing.elapsedMillis !== null)
    facts.push(`elapsed ${formatDuration(ongoing.elapsedMillis)}`);
  if (facts.length > 0) lines.push(facts.join(' · '));

  if (!ongoing.withinCalendarHours && !ongoing.paused) {
    lines.push('_outside working hours — the clock is not running right now_');
  }

  return lines;
}

export function formatRequestSlas(key: string, slas: readonly RequestSla[]): string {
  if (slas.length === 0) {
    // Verified against a live tenant: an SLA-less project answers 200 with an
    // empty page rather than 404, so this is the normal reading of empty. It
    // is worth saying which of the two it is, because "no SLAs" and "no SLAs
    // *breaching*" are opposite answers to the question usually being asked.
    return (
      `${key} has no SLA metrics. Either the service desk project has none configured, or ` +
      'none of them apply to this request type. A request raised moments ago can also read ' +
      'as empty for a minute or two before its metrics appear.'
    );
  }

  const blocks = slas.map((sla) => {
    const lines = [`**${sla.name}**`];

    if (sla.ongoing !== null) {
      lines.push(...describeOngoing(sla.ongoing).map((line) => `  ${line}`));
    }

    if (sla.completed.length > 0) {
      const last = sla.completed[sla.completed.length - 1] as SlaCycle;
      const breachedCount = sla.completed.filter((cycle) => cycle.breached).length;
      const verdict = last.breached ? 'breached' : 'met';
      const elapsed =
        last.elapsedMillis === null ? '' : ` in ${formatDuration(last.elapsedMillis)}`;
      const goal =
        last.goalMillis === null ? '' : ` against a ${formatDuration(last.goalMillis)} goal`;
      const stopped = last.stopTime === null ? '' : `, finished ${last.stopTime}`;

      lines.push(`  completed: ${verdict}${elapsed}${goal}${stopped}`);
      if (sla.completed.length > 1) {
        // Reopening a request starts a new cycle, so this is how a request that
        // currently looks fine can still have missed the SLA earlier.
        lines.push(
          `  _${sla.completed.length} cycles on this metric, ${breachedCount} breached — the request was reopened_`,
        );
      }
    }

    if (sla.ongoing === null && sla.completed.length === 0) {
      lines.push('  no cycle has started — the clock has not been triggered on this request');
    }

    return lines.join('\n');
  });

  return [`SLAs on ${key}:`, '', ...blocks].join('\n');
}
