/**
 * What a tool's preview builder is, and the small helpers they share.
 *
 * A builder is a pure function from the call's arguments to the card its
 * person should see (act-card.ts says what a card is made of). It does no
 * I/O — registration enumerates builders without a database or a provider —
 * so it can only show what the arguments hold. Where a card would be better
 * for knowing the current state (the status an issue is in now, the title of
 * the message being moved), the argument is all there is and the card says
 * what it can: the key, the id, the name it was given.
 */

import type { ActCardSpec, Person, Ref } from '@/lib/mcp-widgets/src/act-card';

export type Args = Record<string, unknown>;

export interface PreviewSpec extends ActCardSpec {
  /**
   * Arguments added to the call the confirm button makes. For a tool with
   * its own "preview, then call again with confirm: true" step (JSM Ops),
   * the card IS that preview, so its button supplies the confirm.
   */
  confirmWith?: Args;
}

export type PreviewBuilder = (args: Args) => PreviewSpec;

export const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter(Boolean) : [];

export const record = (value: unknown): Args =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

export const records = (value: unknown): Args[] => (Array.isArray(value) ? value.map(record) : []);

export const yes = (value: unknown): boolean => value === true;

export function ref(label: string, title?: string, context?: string): Ref {
  return {
    label,
    ...(title ? { title } : {}),
    ...(context ? { context } : {}),
  };
}

/** The first `max` characters, with an ellipsis when something was cut. */
export function clip(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function people(values: string[], kind: Person['kind'] = 'user'): Person[] {
  return values.map((name) => ({ name, kind }));
}

/** A value for a card row; objects and arrays are shown as compact JSON. */
export function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : clip(JSON.stringify(value), 600);
}

/** "1 issue" / "3 issues". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
