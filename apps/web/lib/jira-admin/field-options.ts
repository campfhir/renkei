/**
 * Field option changes — the first kind of Jira admin change request
 * (stage 1b of docs/project-management-design.md): add, rename, disable,
 * enable and reorder the options of one select-type custom field, in one
 * of its contexts, at one level (a field's options, or one cascading
 * parent's children). The most frequent maintenance chore there is — "can
 * you add Vendor to Source" — and the smallest unit a person can review in
 * one glance.
 *
 * Two halves share one rulebook. Planning (the propose tool) resolves the
 * names a model passed to option ids against the live context and refuses
 * anything that could not apply; applying (the apply route) reads the
 * context again, re-checks every operation against what is there NOW, and
 * stops at the first one that no longer holds — an option someone added
 * by hand since, one that was renamed — leaving everything after it
 * unrun. `checkOperation` is that rulebook, so a proposal that passed
 * planning fails at apply only when Jira itself moved underneath it.
 *
 * Nothing here deletes. A disabled option stays on the issues that carry
 * it and just cannot be picked again; deleting one would strip it from
 * every issue that used it (the design's "no deletes in phase 1").
 */

import {
  jiraAdminGet,
  jiraAdminSend,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';
import type { OperationResult } from './change-requests';

export const FIELD_OPTIONS_KIND = 'field_options';

/** Jira's own cap on an option's value. */
export const MAX_OPTION_LENGTH = 255;

/** Pages of 100 read before a context is judged too large to check. */
const MAX_OPTION_PAGES = 20;

/** A live option, as the options endpoint lists it. */
export interface LiveOption {
  id: string;
  value: string;
  disabled: boolean;
  /** The cascading parent's id; null for a top-level option. */
  parentId: string | null;
}

/**
 * An option a move names: by id when it existed at planning time, by value
 * alone when this same request adds it (its id does not exist until then).
 */
export interface OptionRef {
  id?: string;
  value: string;
}

export type OptionOperation =
  | { op: 'add'; values: string[] }
  | { op: 'rename'; renames: { optionId: string; from: string; to: string }[] }
  | { op: 'enable'; options: { optionId: string; value: string }[] }
  | { op: 'disable'; options: { optionId: string; value: string }[] }
  | { op: 'move'; options: OptionRef[]; position: 'First' | 'Last' };

export interface FieldOptionsPayload {
  field: { id: string; name: string; type: string };
  context: {
    id: string;
    name: string;
    global: boolean;
    /** Keys of the spaces a non-global context covers, for the review page. */
    spaces: string[];
  };
  /** Set when the changes apply to one cascading parent's children. */
  parent: { id: string; value: string } | null;
  operations: OptionOperation[];
}

/** What a model asked for, by option value. */
export interface OptionChangeInput {
  add?: string[];
  rename?: { from: string; to: string }[];
  disable?: string[];
  enable?: string[];
  move?: { options: string[]; position?: 'first' | 'last' };
  sortAlphabetically?: boolean;
}

type Check = { ok: true } | { ok: false; reason: string };

interface LogScope {
  tenantId: string;
  subject?: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function quoted(values: readonly string[], max = 8): string {
  const shown = values.slice(0, max).map((value) => `“${value}”`);
  return values.length > max
    ? `${shown.join(', ')} and ${values.length - max} more`
    : shown.join(', ');
}

// ---- describing --------------------------------------------------------

/** One operation in plain words, for the review page, the tool result and the audit trail. */
export function describeOperation(operation: OptionOperation): string {
  switch (operation.op) {
    case 'add':
      return operation.values.length === 1
        ? `Add option ${quoted(operation.values)}`
        : `Add ${operation.values.length} options: ${quoted(operation.values)}`;
    case 'rename':
      return operation.renames
        .map((rename) => `Rename “${rename.from}” to “${rename.to}”`)
        .join('; ');
    case 'enable':
      return `Enable ${quoted(operation.options.map((option) => option.value))}`;
    case 'disable':
      return `Disable ${quoted(operation.options.map((option) => option.value))}`;
    case 'move': {
      const where = operation.position === 'First' ? 'to the top' : 'to the bottom';
      return operation.options.length > 8
        ? `Reorder ${operation.options.length} options, in this order: ${quoted(
            operation.options.map((option) => option.value),
            5
          )}`
        : `Move ${quoted(operation.options.map((option) => option.value))} ${where}` +
            (operation.options.length > 1 ? ', in that order' : '');
    }
  }
}

/** Where the changes land, for a person deciding whether to apply them. */
export function describeReach(payload: FieldOptionsPayload): string {
  const level = payload.parent ? ` under “${payload.parent.value}”` : '';
  if (payload.context.global) {
    return (
      `The global context “${payload.context.name}”${level} — it reaches every space ` +
      'that has no context of its own for this field.'
    );
  }
  const spaces = payload.context.spaces;
  return (
    `The context “${payload.context.name}”${level}` +
    (spaces.length > 0 ? `, used by ${spaces.join(', ')}.` : '.')
  );
}

/** "Source (OPS context): add “Vendor”; disable “Legacy”" — a list row's title. */
export function titleFor(payload: FieldOptionsPayload): string {
  const parts = payload.operations.map((operation) => {
    const text = describeOperation(operation);
    return text.charAt(0).toLowerCase() + text.slice(1);
  });
  const where = payload.context.global ? 'global context' : `${payload.context.name}`;
  const level = payload.parent ? ` › ${payload.parent.value}` : '';
  const title = `${payload.field.name} (${where}${level}): ${parts.join('; ')}`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading -------------------------------------------------------------

function isOperation(value: unknown): value is OptionOperation {
  const record = rec(value);
  switch (record.op) {
    case 'add':
      return Array.isArray(record.values) && record.values.every((v) => typeof v === 'string');
    case 'rename':
      return (
        Array.isArray(record.renames) &&
        record.renames.every(
          (r) =>
            typeof rec(r).optionId === 'string' &&
            typeof rec(r).from === 'string' &&
            typeof rec(r).to === 'string'
        )
      );
    case 'enable':
    case 'disable':
      return (
        Array.isArray(record.options) &&
        record.options.every(
          (o) => typeof rec(o).optionId === 'string' && typeof rec(o).value === 'string'
        )
      );
    case 'move':
      return (
        (record.position === 'First' || record.position === 'Last') &&
        Array.isArray(record.options) &&
        record.options.every(
          (o) =>
            typeof rec(o).value === 'string' &&
            (rec(o).id === undefined || typeof rec(o).id === 'string')
        )
      );
    default:
      return false;
  }
}

/**
 * The payload as stored, or null when it is not one this code wrote — the
 * apply route runs nothing it cannot read in full.
 */
export function readFieldOptionsPayload(value: unknown): FieldOptionsPayload | null {
  const record = rec(value);
  const field = rec(record.field);
  const context = rec(record.context);
  const parent = record.parent === null ? null : rec(record.parent);
  const operations = record.operations;
  if (
    !str(field.id) ||
    typeof field.name !== 'string' ||
    !str(context.id) ||
    typeof context.name !== 'string' ||
    typeof context.global !== 'boolean' ||
    !Array.isArray(context.spaces) ||
    (parent !== null && (!str(parent.id) || typeof parent.value !== 'string')) ||
    !Array.isArray(operations) ||
    operations.length === 0 ||
    !operations.every(isOperation)
  ) {
    return null;
  }
  return {
    field: { id: str(field.id), name: field.name, type: str(field.type) },
    context: {
      id: str(context.id),
      name: context.name,
      global: context.global,
      spaces: context.spaces.filter((key): key is string => typeof key === 'string'),
    },
    parent: parent ? { id: str(parent.id), value: str(parent.value) } : null,
    operations,
  };
}

/** Every option in a context, both levels, in Jira's display order. */
export async function readContextOptions(
  scope: LogScope,
  access: JiraAdminAccess,
  fieldId: string,
  contextId: string
): Promise<{ ok: true; options: LiveOption[] } | { ok: false; error: string }> {
  const options: LiveOption[] = [];
  for (let page = 0; page < MAX_OPTION_PAGES; page++) {
    const result = await jiraAdminGet(
      scope,
      access,
      `/rest/api/3/field/${encodeURIComponent(fieldId)}/context/${encodeURIComponent(contextId)}` +
        `/option?startAt=${page * 100}&maxResults=100`
    );
    if (!result.ok) return { ok: false, error: result.error };
    const values = records(result.body);
    for (const option of values) {
      options.push({
        id: str(option.id),
        value: str(option.value),
        disabled: option.disabled === true,
        parentId: str(option.optionId) || null,
      });
    }
    if (rec(result.body).isLast !== false || values.length === 0) return { ok: true, options };
  }
  return {
    ok: false,
    error:
      `This context has more than ${MAX_OPTION_PAGES * 100} options; Renkei does not change ` +
      'fields that large yet.',
  };
}

/** The options at one level: top-level ones, or one parent's children. */
export function levelOf(options: readonly LiveOption[], parentId: string | null): LiveOption[] {
  return options.filter((option) => option.parentId === parentId);
}

// ---- the rulebook --------------------------------------------------------

/**
 * Does this operation still make sense against these options? The same
 * rules at planning and at apply, so apply fails only on what changed in
 * between.
 */
export function checkOperation(operation: OptionOperation, level: readonly LiveOption[]): Check {
  const byId = (id: string) => level.find((option) => option.id === id);
  switch (operation.op) {
    case 'add': {
      for (const value of operation.values) {
        const existing = level.find((option) => same(option.value, value));
        if (existing) {
          return {
            ok: false,
            reason: existing.disabled
              ? `“${existing.value}” already exists, disabled — enable it instead of adding it again.`
              : `“${existing.value}” already exists.`,
          };
        }
      }
      return { ok: true };
    }
    case 'rename': {
      for (const rename of operation.renames) {
        const option = byId(rename.optionId);
        if (!option) return { ok: false, reason: `The option “${rename.from}” no longer exists.` };
        if (option.value !== rename.from) {
          return {
            ok: false,
            reason: `“${rename.from}” has been renamed to “${option.value}” since this was proposed.`,
          };
        }
        const clash = level.find(
          (other) => other.id !== rename.optionId && same(other.value, rename.to)
        );
        if (clash) return { ok: false, reason: `An option named “${clash.value}” already exists.` };
      }
      return { ok: true };
    }
    case 'enable':
    case 'disable': {
      for (const target of operation.options) {
        const option = byId(target.optionId);
        if (!option) return { ok: false, reason: `The option “${target.value}” no longer exists.` };
        if (option.value !== target.value) {
          return {
            ok: false,
            reason: `“${target.value}” has been renamed to “${option.value}” since this was proposed.`,
          };
        }
      }
      return { ok: true };
    }
    case 'move': {
      for (const ref of operation.options) {
        const found = ref.id ? byId(ref.id) : level.find((option) => same(option.value, ref.value));
        if (!found) return { ok: false, reason: `The option “${ref.value}” no longer exists.` };
      }
      return { ok: true };
    }
  }
}

/** The level as it would read after this operation — planning's dry run. */
function simulate(operation: OptionOperation, level: LiveOption[]): LiveOption[] {
  switch (operation.op) {
    case 'add':
      return [
        ...level,
        ...operation.values.map((value) => ({
          id: '',
          value,
          disabled: false,
          parentId: level[0]?.parentId ?? null,
        })),
      ];
    case 'rename':
      return level.map((option) => {
        const rename = operation.renames.find((r) => r.optionId === option.id);
        return rename ? { ...option, value: rename.to } : option;
      });
    case 'enable':
    case 'disable':
      return level.map((option) =>
        operation.options.some((target) => target.optionId === option.id)
          ? { ...option, disabled: operation.op === 'disable' }
          : option
      );
    case 'move':
      return level;
  }
}

// ---- planning --------------------------------------------------------------

function cleanValues(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * Turn a request by value into operations by id, or say why it cannot be
 * proposed. Order is fixed — add, rename, enable, disable, move — so a move
 * can place options this same request adds or renames.
 */
export function planOptionOperations(
  input: OptionChangeInput,
  level: readonly LiveOption[]
): { ok: true; operations: OptionOperation[] } | { ok: false; reason: string } {
  const add = cleanValues(input.add);
  const renames = (input.rename ?? [])
    .map((rename) => ({ from: rename.from.trim(), to: rename.to.trim() }))
    .filter((rename) => rename.from && rename.to);
  const enable = cleanValues(input.enable);
  const disable = cleanValues(input.disable);
  const moveValues = cleanValues(input.move?.options);

  if (moveValues.length > 0 && input.sortAlphabetically) {
    return { ok: false, reason: 'Pass move or sortAlphabetically, not both.' };
  }
  if (
    add.length + renames.length + enable.length + disable.length + moveValues.length === 0 &&
    !input.sortAlphabetically
  ) {
    return { ok: false, reason: 'Nothing to change: pass add, rename, disable, enable or move.' };
  }

  const tooLong = [...add, ...renames.map((rename) => rename.to)].find(
    (value) => value.length > MAX_OPTION_LENGTH
  );
  if (tooLong) {
    return {
      ok: false,
      reason: `“${tooLong.slice(0, 40)}…” is longer than Jira’s ${MAX_OPTION_LENGTH} characters.`,
    };
  }
  const duplicate = add.find((value, index) => add.findIndex((v) => same(v, value)) !== index);
  if (duplicate) return { ok: false, reason: `“${duplicate}” is in add twice.` };

  // One change per option: renaming and then disabling the same one in a
  // single request reads ambiguously on the review page, and gains nothing.
  const touched = new Map<string, string>();
  const find = (value: string) => level.find((option) => same(option.value, value));
  const claim = (value: string, as: string): Check => {
    const option = find(value);
    if (!option) {
      const close = level
        .filter((candidate) => candidate.value.toLowerCase().includes(value.toLowerCase()))
        .slice(0, 5)
        .map((candidate) => candidate.value);
      return {
        ok: false,
        reason:
          `There is no option “${value}” here.` +
          (close.length > 0 ? ` Did you mean ${quoted(close)}?` : ''),
      };
    }
    const earlier = touched.get(option.id);
    if (earlier) {
      return {
        ok: false,
        reason: `“${option.value}” is both ${earlier} and ${as} — one change per option per request.`,
      };
    }
    touched.set(option.id, as);
    return { ok: true };
  };

  const operations: OptionOperation[] = [];
  if (add.length > 0) operations.push({ op: 'add', values: add });

  if (renames.length > 0) {
    const planned: { optionId: string; from: string; to: string }[] = [];
    for (const rename of renames) {
      const claimed = claim(rename.from, 'renamed');
      if (!claimed.ok) return claimed;
      const option = find(rename.from);
      if (!option) continue;
      if (option.value === rename.to) {
        return { ok: false, reason: `“${option.value}” already has that name.` };
      }
      if (add.some((value) => same(value, rename.to))) {
        return { ok: false, reason: `“${rename.to}” is both added and a rename target.` };
      }
      if (planned.some((other) => same(other.to, rename.to))) {
        return { ok: false, reason: `Two options would both be renamed to “${rename.to}”.` };
      }
      planned.push({ optionId: option.id, from: option.value, to: rename.to });
    }
    operations.push({ op: 'rename', renames: planned });
  }

  for (const [values, op] of [
    [enable, 'enable'],
    [disable, 'disable'],
  ] as const) {
    if (values.length === 0) continue;
    const targets: { optionId: string; value: string }[] = [];
    for (const value of values) {
      const claimed = claim(value, op === 'enable' ? 'enabled' : 'disabled');
      if (!claimed.ok) return claimed;
      const option = find(value);
      if (!option) continue;
      if (option.disabled === (op === 'disable')) {
        return { ok: false, reason: `“${option.value}” is already ${op}d.` };
      }
      targets.push({ optionId: option.id, value: option.value });
    }
    operations.push({ op, options: targets });
  }

  // Dry-run what comes before the move, so it can name options this same
  // request adds or renames.
  let after: LiveOption[] = [...level];
  for (const operation of operations) {
    const check = checkOperation(operation, after);
    if (!check.ok) return check;
    after = simulate(operation, after);
  }

  const refFor = (option: LiveOption): OptionRef =>
    option.id ? { id: option.id, value: option.value } : { value: option.value };

  if (moveValues.length > 0) {
    const refs: OptionRef[] = [];
    for (const value of moveValues) {
      const option = after.find((candidate) => same(candidate.value, value));
      if (!option) return { ok: false, reason: `There is no option “${value}” to move.` };
      if (refs.some((ref) => same(ref.value, option.value))) {
        return { ok: false, reason: `“${option.value}” is in move twice.` };
      }
      refs.push(refFor(option));
    }
    operations.push({
      op: 'move',
      options: refs,
      position: input.move?.position === 'last' ? 'Last' : 'First',
    });
  } else if (input.sortAlphabetically) {
    const sorted = [...after].sort((a, b) =>
      a.value.localeCompare(b.value, 'en', { sensitivity: 'base', numeric: true })
    );
    if (sorted.every((option, index) => option === after[index])) {
      if (operations.length === 0) {
        return { ok: false, reason: 'The options are already in alphabetical order.' };
      }
    } else {
      operations.push({ op: 'move', options: sorted.map(refFor), position: 'First' });
    }
  }

  return { ok: true, operations };
}

// ---- applying --------------------------------------------------------------

type Sent = { ok: true; level: LiveOption[]; note?: string } | { ok: false; error: string };

function optionsFrom(body: unknown, parentId: string | null): LiveOption[] {
  return records(rec(body).options).map((option) => ({
    id: str(option.id),
    value: str(option.value),
    disabled: option.disabled === true,
    parentId: str(option.optionId) || parentId,
  }));
}

async function send(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: FieldOptionsPayload,
  operation: OptionOperation,
  level: LiveOption[]
): Promise<Sent> {
  const base =
    `/rest/api/3/field/${encodeURIComponent(payload.field.id)}` +
    `/context/${encodeURIComponent(payload.context.id)}/option`;
  const parentId = payload.parent?.id ?? null;

  switch (operation.op) {
    case 'add': {
      const result = await jiraAdminSend(scope, access, 'POST', base, {
        options: operation.values.map((value) => ({
          value,
          ...(parentId ? { optionId: parentId } : {}),
        })),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, level: [...level, ...optionsFrom(result.body, parentId)] };
    }
    case 'rename': {
      const result = await jiraAdminSend(scope, access, 'PUT', base, {
        options: operation.renames.map((rename) => ({ id: rename.optionId, value: rename.to })),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        level: level.map((option) => {
          const rename = operation.renames.find((r) => r.optionId === option.id);
          return rename ? { ...option, value: rename.to } : option;
        }),
      };
    }
    case 'enable':
    case 'disable': {
      const disabled = operation.op === 'disable';
      // Already there — by hand, since the proposal — is not a failure;
      // the option ends up as reviewed either way.
      const pending = operation.options.filter(
        (target) => level.find((option) => option.id === target.optionId)?.disabled !== disabled
      );
      const already = operation.options.length - pending.length;
      const note = already > 0 ? `${already} already ${operation.op}d.` : undefined;
      if (pending.length === 0) return { ok: true, level, note };
      const result = await jiraAdminSend(scope, access, 'PUT', base, {
        options: pending.map((target) => ({ id: target.optionId, disabled })),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        note,
        level: level.map((option) =>
          pending.some((target) => target.optionId === option.id) ? { ...option, disabled } : option
        ),
      };
    }
    case 'move': {
      const ids = operation.options.map(
        (ref) =>
          ref.id ??
          level.find((option) => same(option.value, ref.value))?.id ??
          // checkOperation found every ref a moment ago; unreachable.
          ''
      );
      const result = await jiraAdminSend(scope, access, 'PUT', `${base}/move`, {
        customFieldOptionIds: ids,
        position: operation.position,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, level };
    }
  }
}

/**
 * Apply a stored proposal: read the context fresh, then run each operation
 * in order, re-checking it first, and stop at the first that fails. What
 * ran before the failure stays — Jira has no transaction to roll back —
 * and the results say exactly which operations did and did not run.
 */
export async function applyFieldOptions(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: FieldOptionsPayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  const fail = (detail: string) => ({
    status: 'failed' as const,
    results: payload.operations.map((operation, index) => ({
      label: describeOperation(operation),
      outcome: index === 0 ? ('failed' as const) : ('not_run' as const),
      ...(index === 0 ? { detail } : {}),
    })),
  });

  const read = await readContextOptions(scope, access, payload.field.id, payload.context.id);
  if (!read.ok) return fail(`Could not read the field’s current options: ${read.error}`);

  if (payload.parent) {
    const parent = read.options.find(
      (option) => option.id === payload.parent?.id && option.parentId === null
    );
    if (!parent) return fail(`The parent option “${payload.parent.value}” no longer exists.`);
    if (parent.value !== payload.parent.value) {
      return fail(
        `The parent option “${payload.parent.value}” has been renamed to “${parent.value}” since this was proposed.`
      );
    }
  }

  let level = levelOf(read.options, payload.parent?.id ?? null);
  let stopped = false;
  for (const operation of payload.operations) {
    const label = describeOperation(operation);
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    const check = checkOperation(operation, level);
    if (!check.ok) {
      results.push({ label, outcome: 'failed', detail: check.reason });
      stopped = true;
      continue;
    }
    const sent = await send(scope, access, payload, operation, level);
    if (!sent.ok) {
      results.push({ label, outcome: 'failed', detail: sent.error });
      stopped = true;
      continue;
    }
    level = sent.level;
    results.push({ label, outcome: 'done', ...(sent.note ? { detail: sent.note } : {}) });
  }

  const done = results.filter((result) => result.outcome === 'done').length;
  return {
    status: done === results.length ? 'applied' : done === 0 ? 'failed' : 'partial',
    results,
  };
}
