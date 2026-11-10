/**
 * Helpers for the cards of connectors whose ids are opaque handles (Mirth,
 * OnBase, Zoom): what to show when a lookup (../lookup.ts) found a name, and
 * what to show when it did not.
 *
 * An argument is sometimes what the person typed (a channel's name, a
 * document type's name) and sometimes an id the model copied from a listing.
 * A typed name reads fine and is kept; anything that looks like an id —
 * a UUID, a bare number, a long opaque token — is never shown. The card
 * says the generic phrase instead ("the channel").
 */

import type { Names } from './card';
import { named, strings, text } from './card';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9\-_=]{20,}$/;

/** Whether a value is a handle rather than wording: a UUID, a bare number, a long opaque token. */
export function looksLikeId(value: unknown): boolean {
  const v = text(value);
  if (!v) return false;
  if (UUID.test(v) || /^\d+$/.test(v)) return true;
  return OPAQUE.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

/** The value as the person wrote it, or '' when it is an id. */
export function readable(value: unknown): string {
  const v = text(value);
  return v && !looksLikeId(v) ? v : '';
}

/** The looked-up name, else a readable (typed) value, else `generic`. Never an id. */
export function labelOr(names: Names, kind: string, value: unknown, generic: string): string {
  return named(names, kind, value) || readable(value) || generic;
}

/** `labelOr` over a list argument (or a single value), one entry each. */
export function labelsOr(names: Names, kind: string, value: unknown, generic: string): string[] {
  const items = Array.isArray(value) ? strings(value) : text(value) ? [text(value)] : [];
  return items.map((item) => labelOr(names, kind, item, generic));
}

/** Names of a found/unfound key, so a lookup can write `{ [nameKey(kind, ref)]: name }` only when it has one. */
export function found(kind: string, ref: unknown, name: unknown): Record<string, string> {
  const key = text(ref);
  const value = text(name);
  return key && value ? { [`${kind}:${key}`]: value } : {};
}
