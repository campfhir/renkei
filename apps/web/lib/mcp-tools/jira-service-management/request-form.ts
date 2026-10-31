/**
 * A request type's form, as the create card and the create tool both need it.
 *
 * `GET …/requesttype/{id}/field` is the authority on which fields a
 * `jsm_create_request` can carry and which of them it MUST carry. The
 * preview reads it to decide which rows the card shows (every required
 * field, plus any optional one the caller supplied or that is a pick list
 * worth offering), and the create handler reads it again to shape what the
 * card handed back.
 *
 * People never see ids. A pick list's rows carry `{ label, value: id }`; the
 * card shows the label and the card's hidden state (`confirmArgs`) holds the
 * id the API wants. The tool also accepts a label where an id belongs (a
 * model that read `jsm_get_request_type_fields` says "High", not "3"), and
 * `shapeFormValue` resolves it, the way components already were.
 */

import { matchComponents, type ComponentOption } from './components';

/** Fields the create already has an argument of its own for, or cannot take. */
const HANDLED_ELSEWHERE = new Set([
  'summary',
  'description',
  'reporter',
  'assignee',
  'attachment',
  'components',
  'priority',
  'requestparticipants',
]);

export interface FormField {
  fieldId: string;
  name: string;
  required: boolean;
  /** `jiraSchema.type`: string, number, date, option, array, user, priority, … */
  type: string;
  /** `jiraSchema.items` for an array: option, component, version, user, string. */
  itemType: string;
  options: ComponentOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The form's fields in the shape this module works with; invisible ones dropped. */
export function describeForm(fields: readonly unknown[]): FormField[] {
  const out: FormField[] = [];
  for (const entry of fields) {
    if (!isRecord(entry) || !str(entry.fieldId)) continue;
    if (entry.visible === false) continue;
    const schema = isRecord(entry.jiraSchema) ? entry.jiraSchema : {};
    const valid = Array.isArray(entry.validValues) ? entry.validValues : [];
    out.push({
      fieldId: str(entry.fieldId),
      name: str(entry.name) || str(entry.fieldId),
      required: entry.required === true,
      type: str(schema.type),
      itemType: str(schema.items),
      options: valid.flatMap((option): ComponentOption[] =>
        isRecord(option) && str(option.value)
          ? [{ id: str(option.value), name: str(option.label) || str(option.value) }]
          : []
      ),
    });
  }
  return out;
}

export function formFieldOf(form: readonly FormField[], fieldId: string): FormField | undefined {
  return form.find((field) => field.fieldId === fieldId);
}

/** True when the value is something a person or model actually filled in. */
export function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(isFilled);
  return true;
}

/**
 * Required fields the form insists on that nothing supplied. `supplied`
 * holds the ids of fields the handler has a value for from any source
 * (its own arguments included), so summary/description/components/priority
 * and the like are judged by the caller rather than guessed at here.
 */
export function missingRequired(
  form: readonly FormField[],
  formFields: Record<string, unknown>,
  supplied: ReadonlySet<string>
): FormField[] {
  return form.filter(
    (field) =>
      field.required &&
      !supplied.has(field.fieldId) &&
      !HANDLED_ELSEWHERE.has(field.fieldId.toLowerCase()) &&
      !isFilled(formFields[field.fieldId])
  );
}

export function describeMissing(fields: readonly FormField[]): string {
  return fields
    .map((field) => {
      const accepts =
        field.options.length > 0
          ? ` — one of ${field.options
              .slice(0, 25)
              .map((option) => `${option.name} (${option.id})`)
              .join(', ')}`
          : '';
      return `${field.name} (${field.fieldId})${accepts}`;
    })
    .join('; ');
}

export type Shaped = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * One form value, shaped the way `requestFieldValues` wants it.
 *
 * `value` may be a label or an id (the card sends ids; a model may send
 * either). `resolveUser` turns an email or name into an accountId.
 */
export async function shapeFormValue(
  field: FormField,
  value: unknown,
  resolveUser: (raw: string) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>
): Promise<Shaped> {
  const asList = (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim());
  const given = asList.filter(Boolean);

  const options = async (): Promise<Shaped> => {
    const matched = matchComponents(given, field.options);
    if (field.options.length === 0) {
      // No list to check against: trust a numeric id, otherwise send a name.
      const items = given.map((entry) => (/^\d+$/.test(entry) ? { id: entry } : { name: entry }));
      return { ok: true, value: items };
    }
    if (matched.missing.length > 0) {
      return {
        ok: false,
        reason: `${matched.missing.map((name) => `"${name}"`).join(', ')} is not one ${field.name} accepts — it accepts ${field.options
          .map((option) => `${option.name} (${option.id})`)
          .join(', ')}`,
      };
    }
    return { ok: true, value: matched.resolved.map((option) => ({ id: option.id })) };
  };

  const users = async (): Promise<Shaped> => {
    const ids: { accountId: string }[] = [];
    for (const entry of given) {
      const resolved = await resolveUser(entry);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      ids.push({ accountId: resolved.id });
    }
    return { ok: true, value: ids };
  };

  const single = (shaped: Shaped): Shaped =>
    shaped.ok && Array.isArray(shaped.value) ? { ok: true, value: shaped.value[0] } : shaped;

  switch (field.type) {
    case 'number': {
      const n = Number(given[0]);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, reason: `"${given[0] ?? ''}" is not a number` };
    }
    case 'option':
    case 'priority':
    case 'securitylevel':
      return single(await options());
    case 'user':
      return single(await users());
    case 'array':
      if (field.itemType === 'user') return users();
      if (
        field.itemType === 'option' ||
        field.itemType === 'component' ||
        field.itemType === 'version'
      ) {
        return options();
      }
      return { ok: true, value: given };
    default:
      // A string-ish field with a closed list (a select the schema calls
      // string) still takes the option's id.
      if (field.options.length > 0) return single(await options());
      return { ok: true, value: typeof value === 'string' ? value : given.join(', ') };
  }
}

/** What the card edits a field with: a pick list, a checkbox group, or text. */
export function controlFor(field: FormField): {
  kind: 'select' | 'chips' | 'number' | 'text' | 'text-array';
  options: { label: string; value: string }[];
} {
  const options = field.options.map((option) => ({ label: option.name, value: option.id }));
  const multi =
    field.type === 'array' &&
    (field.itemType === 'option' || field.itemType === 'component' || field.itemType === 'version');
  if (options.length > 0) return { kind: multi ? 'chips' : 'select', options };
  if (field.type === 'number') return { kind: 'number', options: [] };
  if (field.type === 'array') return { kind: 'text-array', options: [] };
  return { kind: 'text', options: [] };
}

/** The ids behind what was supplied, so the card's controls start on them. */
function initialValue(field: FormField, raw: unknown): string | string[] {
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map(
    (entry) => String(entry).trim()
  );
  const resolved = list.map(
    (entry) => matchComponents([entry], field.options).resolved[0]?.id ?? entry
  );
  return controlFor(field).kind === 'chips' ? resolved : (resolved[0] ?? '');
}

export interface CardRow {
  label: string;
  value: string;
  editable?: {
    path: string[];
    kind: 'select' | 'chips' | 'number' | 'text' | 'text-array';
    value: string | string[];
    options: { label: string; value: string }[];
  };
}

/** The label a card shows for what was supplied for a field. */
function shown(field: FormField, raw: unknown): string {
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  return list
    .map((entry) => matchComponents([entry], field.options).resolved[0]?.name ?? entry)
    .join(', ');
}

/**
 * The card rows the form asks for.
 *
 * Shown: every required field the create has no argument for; components and
 * priority whenever the form carries them (a pick list, so the person can
 * choose even when nobody asked); and any other optional field the caller
 * already supplied. Each is editable, with its path into `confirmArgs` —
 * `components`/`priority` are their own arguments, everything else lives
 * under `formFields`.
 */
export function formCardRows(
  form: readonly FormField[],
  args: { components?: unknown; priority?: unknown; formFields?: unknown }
): CardRow[] {
  const formFields = isRecord(args.formFields) ? args.formFields : {};
  const rows: CardRow[] = [];
  for (const field of form) {
    const lower = field.fieldId.toLowerCase();
    let raw: unknown;
    let path: string[];
    if (lower === 'components') {
      raw = args.components;
      path = ['components'];
    } else if (lower === 'priority') {
      raw = args.priority;
      path = ['priority'];
    } else if (HANDLED_ELSEWHERE.has(lower)) {
      continue;
    } else {
      raw = formFields[field.fieldId];
      path = ['formFields', field.fieldId];
      if (!field.required && !isFilled(raw)) continue;
    }
    const control = controlFor(field);
    const pickList = lower === 'components' || lower === 'priority';
    if (pickList && control.options.length === 0 && !isFilled(raw)) continue;
    const needed = field.required && !isFilled(raw);
    rows.push({
      label: field.required ? `${field.name} (required)` : field.name,
      value: shown(field, raw) || (needed ? 'Choose one' : '—'),
      editable: {
        path,
        kind:
          lower === 'components'
            ? control.options.length > 0
              ? 'chips'
              : 'text-array'
            : control.kind,
        value: initialValue(field, raw),
        options: control.options,
      },
    });
  }
  return rows;
}
