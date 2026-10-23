/**
 * Metadata API XML from the JSON the Tooling API returns in a record's
 * `Metadata` field — the round trip the admin connector needs for
 * components a deploy replaces whole (a page layout, an existing field):
 * read the current definition, change what the proposal changes, write the
 * whole thing back (docs/salesforce-connectors-design.md, "Writes go
 * through the Metadata API, as deploys").
 *
 * The Tooling API's JSON is the Metadata API's shape with the element
 * names as keys: an array is the element repeated, an object a nested
 * element, `null` an element not set (left out here). Pure.
 */

import { METADATA_NAMESPACE, xmlEscape } from './metadata';

/**
 * Keys the Tooling API adds at the top of `Metadata` that are not elements
 * of the component. Below the top they are real (a picklist value's
 * `fullName`), so only the top is filtered.
 */
const NOT_ELEMENTS = new Set(['urls', 'fullName']);

function write(name: string, value: unknown, indent: string, out: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) write(name, item, indent, out);
    return;
  }
  if (typeof value === 'object') {
    const inner: string[] = [];
    for (const [key, child] of Object.entries(value)) write(key, child, `${indent}    `, inner);
    out.push(
      inner.length
        ? `${indent}<${name}>\n${inner.join('')}${indent}</${name}>\n`
        : `${indent}<${name}/>\n`
    );
    return;
  }
  out.push(`${indent}<${name}>${xmlEscape(String(value))}</${name}>\n`);
}

/** The element body (no XML declaration) for one component's metadata. */
export function metadataBody(value: Record<string, unknown>, indent = '    '): string {
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (NOT_ELEMENTS.has(key)) continue;
    write(key, child, indent, out);
  }
  return out.join('');
}

/** A whole component file: `<Layout xmlns=…>…</Layout>`. */
export function metadataFile(type: string, value: Record<string, unknown>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="${METADATA_NAMESPACE}">\n` +
    `${metadataBody(value)}</${type}>\n`
  );
}

/**
 * A component's file name in the source format: its full name with every
 * character but letters, digits, space, `_`, `.` and `-` percent-encoded,
 * the way the Metadata API names them — `Account-Account %28Marketing%29 Layout`.
 */
export function metadataFileName(fullName: string): string {
  let out = '';
  for (const ch of fullName) {
    if (/[A-Za-z0-9 _.-]/.test(ch)) out += ch;
    else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}
