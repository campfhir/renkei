/**
 * Page layouts: reading one as sections of fields, and merging a proposal's
 * changes into it. A layout deploys whole, so a proposal reads the live
 * layout (the Tooling API's `Layout.Metadata`), changes only what it says —
 * fields added to a section, fields removed, new sections — and the
 * result is deployed as the whole layout, with the review page listing
 * exactly what moved. Pure.
 */

import { isRecord } from '@renkei/guards';

type Json = Record<string, unknown>;

export type FieldBehavior = 'Edit' | 'Required' | 'Readonly';

export interface LayoutSectionView {
  label: string;
  /** Each column's fields, top to bottom. */
  columns: string[][];
}

export interface LayoutChanges {
  /** Fields to place; `section` by its label (default: the first section with fields). */
  add?: { field: string; section?: string; behavior?: FieldBehavior }[];
  /** Fields to take off the layout. */
  remove?: string[];
  /** New sections, after the last section that holds fields. */
  addSections?: {
    label: string;
    columns?: 1 | 2;
    fields?: { field: string; behavior?: FieldBehavior }[];
  }[];
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function sectionsOf(layout: Json): Json[] {
  return list(layout.layoutSections);
}

function columnsOf(section: Json): Json[] {
  return list(section.layoutColumns);
}

function itemsOf(column: Json): Json[] {
  return list(column.layoutItems);
}

function fieldOf(item: Json): string {
  return typeof item.field === 'string' ? item.field : '';
}

/** The layout as a person reads it: each section's label and its fields by column. */
export function layoutSections(layout: Json): LayoutSectionView[] {
  return sectionsOf(layout).map((section) => ({
    label: typeof section.label === 'string' ? section.label : '',
    columns: columnsOf(section).map((column) => itemsOf(column).map(fieldOf).filter(Boolean)),
  }));
}

/** Every field on the layout, lower-cased. */
export function layoutFieldSet(layout: Json): Set<string> {
  const fields = new Set<string>();
  for (const section of layoutSections(layout)) {
    for (const column of section.columns)
      for (const field of column) fields.add(field.toLowerCase());
  }
  return fields;
}

/**
 * The layout with the changes merged in, and what moved in words — or
 * every reason it cannot be done (a field already on the layout, a section
 * that does not exist, a field to remove that is not there).
 */
export function mergeLayoutChanges(
  layout: Json,
  changes: LayoutChanges
): { ok: true; layout: Json; summary: string[] } | { ok: false; errors: string[] } {
  const next = structuredClone(layout);
  const errors: string[] = [];
  const summary: string[] = [];
  const sections = sectionsOf(next);
  next.layoutSections = sections;

  for (const field of changes.remove ?? []) {
    let removed = false;
    for (const section of sections) {
      for (const column of columnsOf(section)) {
        const before = itemsOf(column);
        const after = before.filter((item) => fieldOf(item).toLowerCase() !== field.toLowerCase());
        if (after.length !== before.length) {
          column.layoutItems = after;
          removed = true;
        }
      }
    }
    if (removed) summary.push(`Remove ${field}`);
    else errors.push(`${field} is not on this layout.`);
  }

  const onLayout = layoutFieldSet(next);
  const placing = new Set<string>();
  const claim = (field: string): boolean => {
    const key = field.toLowerCase();
    if (onLayout.has(key) || placing.has(key)) {
      errors.push(`${field} is already on this layout.`);
      return false;
    }
    placing.add(key);
    return true;
  };

  for (const add of changes.add ?? []) {
    if (!claim(add.field)) continue;
    const section = add.section
      ? sections.find(
          (s) => typeof s.label === 'string' && s.label.toLowerCase() === add.section?.toLowerCase()
        )
      : sections.find((s) => columnsOf(s).some((c) => itemsOf(c).some((item) => fieldOf(item))));
    if (!section) {
      errors.push(
        add.section
          ? `This layout has no section “${add.section}”. Its sections: ${layoutSections(next)
              .map((s) => s.label)
              .filter(Boolean)
              .join(', ')}.`
          : 'This layout has no section with fields to add to; name a section, or add one.'
      );
      continue;
    }
    const columns = columnsOf(section);
    if (columns.length === 0) {
      section.layoutColumns = [{ layoutItems: [] }];
    }
    const target = columnsOf(section).reduce((shortest, column) =>
      itemsOf(column).length < itemsOf(shortest).length ? column : shortest
    );
    target.layoutItems = [
      ...itemsOf(target),
      { behavior: add.behavior ?? 'Edit', field: add.field },
    ];
    summary.push(
      `Add ${add.field} to “${String(section.label ?? '')}”${add.behavior === 'Required' ? ' (required here)' : add.behavior === 'Readonly' ? ' (read only here)' : ''}`
    );
  }

  if ((changes.addSections ?? []).length > 0) {
    const lastWithFields = sections.reduce(
      (last, section, index) =>
        columnsOf(section).some((c) => itemsOf(c).some((item) => fieldOf(item))) ? index : last,
      sections.length - 1
    );
    const created: Json[] = [];
    for (const spec of changes.addSections ?? []) {
      const label = spec.label.trim();
      if (!label) {
        errors.push('A new section needs a label.');
        continue;
      }
      if (
        sections.some(
          (s) => typeof s.label === 'string' && s.label.toLowerCase() === label.toLowerCase()
        )
      ) {
        errors.push(`This layout already has a section “${label}”.`);
        continue;
      }
      const count = spec.columns === 1 ? 1 : 2;
      const columns: Json[] = Array.from({ length: count }, (): Json => ({ layoutItems: [] }));
      for (const [index, field] of (spec.fields ?? []).entries()) {
        if (!claim(field.field)) continue;
        const column = columns[index % count];
        column.layoutItems = [
          ...itemsOf(column),
          { behavior: field.behavior ?? 'Edit', field: field.field },
        ];
      }
      created.push({
        customLabel: true,
        detailHeading: true,
        editHeading: true,
        label,
        layoutColumns: columns,
        style: count === 1 ? 'OneColumn' : 'TwoColumnsTopToBottom',
      });
      summary.push(
        `New section “${label}”${(spec.fields ?? []).length ? ` with ${(spec.fields ?? []).map((f) => f.field).join(', ')}` : ''}`
      );
    }
    sections.splice(lastWithFields + 1, 0, ...created);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, layout: next, summary };
}
