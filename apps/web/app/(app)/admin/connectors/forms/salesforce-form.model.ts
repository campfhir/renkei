/**
 * The Salesforce connectors form's rules (salesforce-form.tsx), for both
 * types — CRM and admin (lib/salesforce-kinds.ts): what the list says
 * when it is empty and what its add button reads, what a connector's
 * summary shows, and the editor's draft — its defaults for a first or a
 * further org, the capability boxes it starts from, what Save sends,
 * what a refusal leaves on screen and the armed Remove.
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; everything decided from that is here, and
 * tested in salesforce-form.model.test.ts. The server's own rules (My
 * Domain checks, one connector per org, hidden fields' shape, the stored
 * secret) are route tests beside app/api/admin/connectors/salesforce.
 */

import { SALESFORCE_ADMIN_KIND, type SalesforceKind } from '@/lib/salesforce-kinds';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';

export interface SalesforceConnectorRow {
  key: string;
  name: string;
  myDomain: string;
  sandbox: boolean;
  enabled: boolean;
  clientId: string;
  scopes: string;
  excludedObjects: string[];
  excludedFields: string[];
  hideRestricted: boolean;
  productionChanges: boolean;
  hasClientSecret: boolean;
}

export interface SalesforceConfig {
  configured: boolean;
  enabled: boolean;
  connectors: SalesforceConnectorRow[];
}

export const isAdminKind = (kind: SalesforceKind): boolean =>
  kind.key === SALESFORCE_ADMIN_KIND.key;

/* ------------------------------------------------------------------ list */

/** The line under the intro while there are no connectors: where to start. */
export function emptyListHint(kind: SalesforceKind): string {
  return isAdminKind(kind)
    ? 'Start with a sandbox to build in.'
    : 'Start with your production org.';
}

/** The add button's words: a CRM starts with production, building with any org. */
export function addButtonLabel(kind: SalesforceKind, count: number): string {
  if (count > 0) return 'Add a Salesforce org';
  return isAdminKind(kind) ? 'Add your first org' : 'Add your production org';
}

/* --------------------------------------------------------------- summary */

/** The capabilities a connector's stored ceiling lets people grant, by label. */
export function capabilityLabels(kind: SalesforceKind, scopes: string): string[] {
  const stored = new Set(scopes.split(/\s+/));
  return kind.scopeOptions
    .filter((option) => optionWithin(option, stored))
    .map((option) => option.label);
}

/** An admin connector's change-request line: a sandbox applies them, production only if allowed. */
export function changeRequestsLine(
  connector: Pick<SalesforceConnectorRow, 'sandbox' | 'productionChanges'>
): string {
  if (connector.sandbox) return 'Applied here when the person approves them';
  return connector.productionChanges
    ? 'Allowed in this production org'
    : 'Not in this production org — read only';
}

/** The connector's hidden objects and fields, in one line. */
export function keptAway(
  connector: Pick<SalesforceConnectorRow, 'excludedObjects' | 'excludedFields' | 'hideRestricted'>
): string {
  const parts = [
    ...connector.excludedObjects.map((name) => `${name} (object)`),
    ...connector.excludedFields,
    ...(connector.hideRestricted ? ['fields classified Restricted or Mission Critical'] : []),
  ];
  return parts.join(', ') || 'nothing';
}

/* ---------------------------------------------------------------- editor */

export interface EditorProps {
  kind: SalesforceKind;
  existing: SalesforceConnectorRow | null;
  /** The list is empty: this is the organization's first org of this type. */
  isFirst?: boolean;
}

export type TextField =
  'name' | 'myDomain' | 'clientId' | 'clientSecret' | 'excludedObjects' | 'excludedFields';
export type FlagField = 'sandbox' | 'enabled' | 'hideRestricted' | 'productionChanges';

export interface EditorState {
  name: string;
  myDomain: string;
  sandbox: boolean;
  clientId: string;
  /** Blank keeps the stored secret. */
  clientSecret: string;
  enabled: boolean;
  /** One API name per line, as typed. */
  excludedObjects: string;
  excludedFields: string;
  hideRestricted: boolean;
  productionChanges: boolean;
  checkedIds: ReadonlySet<string>;
  busy: boolean;
  notice: string | null;
  error: string | null;
  confirmingRemove: boolean;
}

export type EditorAction =
  | { type: 'text'; field: TextField; value: string }
  | { type: 'flag'; field: FlagField; value: boolean }
  | { type: 'toggleOption'; optionId: string; on: boolean }
  /** A save or remove went out. */
  | { type: 'sent' }
  | { type: 'saved' }
  /** A save or remove was refused; the draft stays as typed. */
  | { type: 'failed'; error: string }
  | { type: 'armRemove' }
  | { type: 'disarmRemove' };

/** The boxes a connector starts with: its stored ceiling when any box fits it, else the defaults. */
export function initialChecked(kind: SalesforceKind, scopes: string | undefined): Set<string> {
  if (scopes) {
    const stored = new Set(scopes.split(/\s+/));
    const matching = kind.scopeOptions.filter((option) => optionWithin(option, stored));
    if (matching.length > 0) return new Set(matching.map((option) => option.id));
  }
  return new Set(kind.scopeOptions.filter((option) => option.defaultChecked).map((o) => o.id));
}

export function initEditor({ kind, existing, isFirst = false }: EditorProps): EditorState {
  // A CRM usually starts with production; building usually starts in a sandbox.
  const firstIsProduction = isFirst && !isAdminKind(kind);
  return {
    name: existing?.name ?? (firstIsProduction ? 'Production' : ''),
    myDomain: existing?.myDomain ?? '',
    sandbox: existing?.sandbox ?? !firstIsProduction,
    clientId: existing?.clientId ?? '',
    clientSecret: '',
    enabled: existing?.enabled ?? true,
    excludedObjects: (existing?.excludedObjects ?? []).join('\n'),
    excludedFields: (existing?.excludedFields ?? []).join('\n'),
    hideRestricted: existing?.hideRestricted ?? false,
    productionChanges: existing?.productionChanges ?? false,
    checkedIds: initialChecked(kind, existing?.scopes),
    busy: false,
    notice: null,
    error: null,
    confirmingRemove: false,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'text':
      return { ...state, [action.field]: action.value };
    case 'flag':
      return { ...state, [action.field]: action.value };
    case 'toggleOption': {
      const checkedIds = new Set(state.checkedIds);
      if (action.on) checkedIds.add(action.optionId);
      else checkedIds.delete(action.optionId);
      return { ...state, checkedIds };
    }
    case 'sent':
      return { ...state, busy: true, notice: null, error: null };
    case 'saved':
      return { ...state, busy: false, clientSecret: '', notice: 'Saved' };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'armRemove':
      return { ...state, confirmingRemove: true };
    case 'disarmRemove':
      return { ...state, confirmingRemove: false };
  }
}

/**
 * What Save sends (PUT to the type's admin API): trimmed, the secret only
 * when typed, the checked boxes as the ceiling's scopes, and each type's
 * own extras — an admin connector's production switch (never on for a
 * sandbox), a CRM connector's kept-away lists.
 */
export function saveBody(
  kind: SalesforceKind,
  existing: Pick<SalesforceConnectorRow, 'key'> | null,
  state: EditorState
): Record<string, unknown> {
  const secret = state.clientSecret.trim();
  return {
    ...(existing ? { key: existing.key } : {}),
    name: state.name.trim(),
    myDomain: state.myDomain.trim(),
    sandbox: state.sandbox,
    clientId: state.clientId.trim(),
    ...(secret ? { clientSecret: secret } : {}),
    enabled: state.enabled,
    scopes: scopesOfOptions(kind.scopeOptions, state.checkedIds).join(' '),
    ...(isAdminKind(kind)
      ? { productionChanges: !state.sandbox && state.productionChanges }
      : {
          excludedObjects: state.excludedObjects,
          excludedFields: state.excludedFields,
          hideRestricted: state.hideRestricted,
        }),
  };
}

/** Where Remove sends its DELETE. */
export function removeUrl(kind: SalesforceKind, key: string): string {
  return `${kind.adminApi}?key=${encodeURIComponent(key)}`;
}

/** The consumer secret field: required until one is stored, and what its placeholder says. */
export function secretField(existing: Pick<SalesforceConnectorRow, 'hasClientSecret'> | null): {
  required: boolean;
  placeholder: string;
} {
  const stored = existing?.hasClientSecret ?? false;
  return { required: !stored, placeholder: stored ? 'Stored — leave blank to keep' : '' };
}

/** Which of the type's own sections the editor shows. */
export function editorSections(
  kind: SalesforceKind,
  state: Pick<EditorState, 'sandbox'>
): { productionChanges: boolean; keptAway: boolean } {
  const admin = isAdminKind(kind);
  return { productionChanges: admin && !state.sandbox, keptAway: !admin };
}

/** The editor's title. */
export function editorTitle(
  kind: SalesforceKind,
  existing: Pick<SalesforceConnectorRow, 'name'> | null
): string {
  return existing ? `${kind.label} · ${existing.name}` : `New ${kind.label} connector`;
}
