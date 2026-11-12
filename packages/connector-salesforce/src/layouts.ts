/**
 * Page layouts: reading one as sections of fields, and merging a proposal's
 * changes into it. A layout deploys whole, so a proposal reads the live
 * layout (the Tooling API's `Layout.Metadata`), changes only what it says —
 * fields added to a section, moved, removed or made required or read only
 * there, sections added, renamed or removed, related lists added or
 * removed — and the result is deployed as the whole layout, with the review
 * page listing exactly what moved. Which profile sees a layout is not in the
 * layout: it deploys as a Profile file holding only that
 * (profileLayoutFile). Pure.
 */

import { isRecord } from '@renkei/guards';
import { metadataFile } from './metadata-xml';

type Json = Record<string, unknown>;

export type FieldBehavior = 'Edit' | 'Required' | 'Readonly';

/** What an entry in the Lightning action bar is, as layout metadata names it. */
export const LAYOUT_ACTION_TYPES = [
  'QuickAction',
  'StandardButton',
  'CustomButton',
  'ProductivityAction',
] as const;
export type LayoutActionType = (typeof LAYOUT_ACTION_TYPES)[number];

export interface LayoutSectionView {
  label: string;
  /** Each column's fields, top to bottom. */
  columns: string[][];
}

export interface RelatedListView {
  /** The list's name in the layout: `RelatedContactList`, or `Child__c.Lookup__c`. */
  relatedList: string;
  /** Its columns, as the layout names them. */
  fields: string[];
}

export interface LayoutChanges {
  /** Fields to place; `section` by its label (default: the first section with fields). */
  add?: { field: string; section?: string; behavior?: FieldBehavior }[];
  /** Fields to take off the layout. */
  remove?: string[];
  /**
   * Fields already on the layout, to move: to another section (the shorter
   * column, at its end), or to a place — a column (1 is the left), and
   * before or after a field that is in the target section.
   */
  move?: { field: string; section?: string; column?: number; before?: string; after?: string }[];
  /** Fields already on the layout, to make editable, required or read only there. */
  setBehavior?: { field: string; behavior: FieldBehavior }[];
  /** Sections to rename, by their label. */
  renameSections?: { section: string; label: string }[];
  /** Sections to take off, by their label; the fields in one leave the layout with it. */
  removeSections?: string[];
  /** Related lists to show, after those already there; `fields` are its columns. */
  addRelatedLists?: { relatedList: string; fields?: string[] }[];
  /** Related lists to take off, by their name in the layout. */
  removeRelatedLists?: string[];
  /** The columns of related lists already on the layout, replaced with these. */
  setRelatedListColumns?: { relatedList: string; fields: string[] }[];
  /** Custom buttons and links to show in the layout's button bar, by API name. */
  addButtons?: string[];
  /** Custom buttons to take off. */
  removeButtons?: string[];
  /**
   * Actions for the Lightning and mobile action bar, after those there. A
   * layout with no list of its own shows Salesforce's defaults; giving it
   * one replaces them with exactly this list.
   */
  addActions?: { name: string; type?: LayoutActionType }[];
  /** Actions to take off the Lightning and mobile action bar. */
  removeActions?: string[];
  /** New sections, after the last section that holds fields. */
  addSections?: {
    label: string;
    columns?: 1 | 2;
    fields?: { field: string; behavior?: FieldBehavior }[];
  }[];
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

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

/** How each field on the layout behaves there, by the field's name lower-cased. */
export function layoutBehaviors(layout: Json): Map<string, FieldBehavior> {
  const behaviors = new Map<string, FieldBehavior>();
  for (const section of sectionsOf(layout)) {
    for (const column of columnsOf(section)) {
      for (const item of itemsOf(column)) {
        const field = fieldOf(item);
        if (!field) continue;
        behaviors.set(
          field.toLowerCase(),
          item.behavior === 'Required' || item.behavior === 'Readonly' ? item.behavior : 'Edit'
        );
      }
    }
  }
  return behaviors;
}

/** The layout's related lists, in order. */
export function layoutRelatedLists(layout: Json): RelatedListView[] {
  return list(layout.relatedLists).flatMap((entry) =>
    typeof entry.relatedList === 'string' && entry.relatedList
      ? [
          {
            relatedList: entry.relatedList,
            fields: Array.isArray(entry.fields)
              ? entry.fields.filter((f): f is string => typeof f === 'string')
              : [],
          },
        ]
      : []
  );
}

/** The layout's custom buttons, and its Lightning action bar when it has its own. */
export function layoutButtons(layout: Json): { buttons: string[]; actions: string[] | null } {
  const own = isRecord(layout.platformActionList) ? layout.platformActionList : null;
  return {
    buttons: strings(layout.customButtons),
    actions: own
      ? list(own.platformActionListItems)
          .slice()
          .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
          .map((a) => String(a.actionName ?? ''))
          .filter(Boolean)
      : null,
  };
}

/**
 * The Profile file that gives a profile a layout — for one record type
 * (`Object.RecordType`), or for records with none. A Profile deploy
 * overlays the profile, so this changes those assignments and nothing else.
 */
export function profileLayoutFile(
  assignments: readonly { layout: string; recordType?: string }[]
): string {
  return metadataFile('Profile', {
    layoutAssignments: assignments.map((a) => ({
      layout: a.layout,
      ...(a.recordType ? { recordType: a.recordType } : {}),
    })),
  });
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

const behaviorWords = (behavior: FieldBehavior): string =>
  behavior === 'Required' ? 'required' : behavior === 'Readonly' ? 'read only' : 'editable';

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

  const labelOf = (section: Json) => (typeof section.label === 'string' ? section.label : '');
  const sectionNamed = (label: string) =>
    sections.find((s) => labelOf(s).toLowerCase() === label.trim().toLowerCase());
  const sectionNames = () =>
    layoutSections(next)
      .map((s) => s.label)
      .filter(Boolean)
      .join(', ');
  const noSection = (label: string) =>
    `This layout has no section “${label}”. Its sections: ${sectionNames()}.`;
  /** The item for a field already on the layout, and the column holding it. */
  const placed = (field: string): { column: Json; item: Json } | null => {
    for (const section of sections) {
      for (const column of columnsOf(section)) {
        const item = itemsOf(column).find((i) => fieldOf(i).toLowerCase() === field.toLowerCase());
        if (item) return { column, item };
      }
    }
    return null;
  };
  const shortestColumn = (section: Json): Json => {
    if (columnsOf(section).length === 0) section.layoutColumns = [{ layoutItems: [] }];
    return columnsOf(section).reduce((shortest, column) =>
      itemsOf(column).length < itemsOf(shortest).length ? column : shortest
    );
  };

  for (const label of changes.removeSections ?? []) {
    const section = sectionNamed(label);
    if (!section) {
      errors.push(noSection(label));
      continue;
    }
    const fields = columnsOf(section).flatMap((c) => itemsOf(c).map(fieldOf).filter(Boolean));
    sections.splice(sections.indexOf(section), 1);
    summary.push(
      `Remove the section “${labelOf(section)}”${fields.length ? `, and with it ${fields.join(', ')}` : ''}`
    );
  }

  for (const rename of changes.renameSections ?? []) {
    const section = sectionNamed(rename.section);
    const label = rename.label.trim();
    if (!section) errors.push(noSection(rename.section));
    else if (!label) errors.push('A section’s new name cannot be blank.');
    else if (sectionNamed(label) && sectionNamed(label) !== section)
      errors.push(`This layout already has a section “${label}”.`);
    else {
      summary.push(`Rename the section “${labelOf(section)}” to “${label}”`);
      section.label = label;
      section.customLabel = true;
    }
  }

  for (const move of changes.move ?? []) {
    const from = placed(move.field);
    if (!from) {
      errors.push(`${move.field} is not on this layout.`);
      continue;
    }
    const home = sections.find((s) => columnsOf(s).includes(from.column));
    const to = move.section ? sectionNamed(move.section) : home;
    if (!to) {
      errors.push(noSection(move.section ?? ''));
      continue;
    }
    const anchorName = move.before ?? move.after;
    const positioned = anchorName !== undefined || move.column !== undefined;
    if (to === home && !positioned) {
      errors.push(`${move.field} is already in “${labelOf(to)}”.`);
      continue;
    }
    if (move.before !== undefined && move.after !== undefined) {
      errors.push(`${move.field}: name before or after, not both.`);
      continue;
    }
    const anchor = anchorName ? placed(anchorName) : null;
    if (anchorName && (!anchor || !columnsOf(to).includes(anchor.column))) {
      errors.push(`${anchorName} is not in “${labelOf(to)}” to place ${move.field} beside.`);
      continue;
    }
    if (anchor && anchor.item === from.item) {
      errors.push(`${move.field} cannot be placed beside itself.`);
      continue;
    }
    if (columnsOf(to).length === 0) to.layoutColumns = [{ layoutItems: [] }];
    let target: Json;
    if (anchor) target = anchor.column;
    else if (move.column !== undefined) {
      const column = columnsOf(to)[move.column - 1];
      if (!column) {
        errors.push(`“${labelOf(to)}” has ${columnsOf(to).length} column(s), not ${move.column}.`);
        continue;
      }
      target = column;
    } else target = shortestColumn(to);
    from.column.layoutItems = itemsOf(from.column).filter((item) => item !== from.item);
    const items = itemsOf(target);
    const at = anchor
      ? items.indexOf(anchor.item) + (move.after !== undefined ? 1 : 0)
      : items.length;
    target.layoutItems = [...items.slice(0, at), from.item, ...items.slice(at)];
    const where = anchor
      ? ` ${move.after !== undefined ? 'after' : 'before'} ${fieldOf(anchor.item)}`
      : move.column !== undefined
        ? `, column ${move.column}`
        : '';
    summary.push(
      to === home
        ? `Move ${fieldOf(from.item)}${where.replace(/^, /, ' to ')} in “${labelOf(to)}”`
        : `Move ${fieldOf(from.item)} to “${labelOf(to)}”${where}`
    );
  }

  for (const change of changes.setBehavior ?? []) {
    const at = placed(change.field);
    if (!at) errors.push(`${change.field} is not on this layout.`);
    else if ((at.item.behavior ?? 'Edit') === change.behavior)
      errors.push(`${change.field} is already ${behaviorWords(change.behavior)} on this layout.`);
    else {
      at.item.behavior = change.behavior;
      summary.push(`Make ${fieldOf(at.item)} ${behaviorWords(change.behavior)} here`);
    }
  }

  if ((changes.removeRelatedLists ?? []).length + (changes.addRelatedLists ?? []).length > 0) {
    let lists = list(next.relatedLists);
    const named = (name: string) =>
      lists.find((l) => String(l.relatedList ?? '').toLowerCase() === name.trim().toLowerCase());
    for (const name of changes.removeRelatedLists ?? []) {
      const found = named(name);
      if (!found) {
        errors.push(
          `This layout has no related list ${name}. Its related lists: ${
            lists.map((l) => String(l.relatedList ?? '')).join(', ') || 'none'
          }.`
        );
        continue;
      }
      lists = lists.filter((l) => l !== found);
      summary.push(`Remove the related list ${String(found.relatedList)}`);
    }
    for (const add of changes.addRelatedLists ?? []) {
      const name = add.relatedList.trim();
      if (named(name)) {
        errors.push(`The related list ${name} is already on this layout.`);
        continue;
      }
      const fields = (add.fields ?? []).map((f) => f.trim()).filter(Boolean);
      lists = [...lists, { ...(fields.length ? { fields } : {}), relatedList: name }];
      summary.push(
        `Add the related list ${name}${fields.length ? ` showing ${fields.join(', ')}` : ''}`
      );
    }
    next.relatedLists = lists;
  }

  for (const set of changes.setRelatedListColumns ?? []) {
    const lists = list(next.relatedLists);
    const found = lists.find(
      (l) => String(l.relatedList ?? '').toLowerCase() === set.relatedList.trim().toLowerCase()
    );
    const fields = set.fields.map((f) => f.trim()).filter(Boolean);
    if (!found) {
      errors.push(
        `This layout has no related list ${set.relatedList}. Its related lists: ${
          lists.map((l) => String(l.relatedList ?? '')).join(', ') || 'none'
        }.`
      );
    } else if (fields.length === 0) {
      errors.push(`Name the columns ${set.relatedList} is to show.`);
    } else {
      found.fields = fields;
      next.relatedLists = lists;
      summary.push(`Show ${fields.join(', ')} in the related list ${String(found.relatedList)}`);
    }
  }

  if ((changes.addButtons ?? []).length + (changes.removeButtons ?? []).length > 0) {
    let buttons = strings(next.customButtons);
    const has = (name: string) => buttons.some((b) => b.toLowerCase() === name.toLowerCase());
    for (const name of (changes.removeButtons ?? []).map((b) => b.trim())) {
      if (!has(name)) {
        errors.push(
          `This layout has no custom button ${name}. Its custom buttons: ${buttons.join(', ') || 'none'}.`
        );
        continue;
      }
      buttons = buttons.filter((b) => b.toLowerCase() !== name.toLowerCase());
      summary.push(`Remove the button ${name}`);
    }
    for (const name of (changes.addButtons ?? []).map((b) => b.trim())) {
      if (has(name)) {
        errors.push(`The button ${name} is already on this layout.`);
        continue;
      }
      buttons = [...buttons, name];
      summary.push(`Add the button ${name}`);
    }
    next.customButtons = buttons;
  }

  if ((changes.addActions ?? []).length + (changes.removeActions ?? []).length > 0) {
    const own = isRecord(next.platformActionList) ? next.platformActionList : null;
    let actions = own ? list(own.platformActionListItems) : [];
    const nameOf = (action: Json) => String(action.actionName ?? '');
    const has = (name: string) =>
      actions.some((a) => nameOf(a).toLowerCase() === name.toLowerCase());
    for (const name of (changes.removeActions ?? []).map((a) => a.trim())) {
      if (!own) {
        errors.push(
          'This layout has no action list of its own: it shows Salesforce’s default actions, which are not listed in it to take off.'
        );
        break;
      }
      if (!has(name)) {
        errors.push(
          `This layout’s action bar has no ${name}. It has: ${actions.map(nameOf).join(', ') || 'none'}.`
        );
        continue;
      }
      actions = actions.filter((a) => nameOf(a).toLowerCase() !== name.toLowerCase());
      summary.push(`Remove the action ${name}`);
    }
    const adding = (changes.addActions ?? []).filter((add) => {
      if (!has(add.name.trim())) return true;
      errors.push(`The action ${add.name.trim()} is already on this layout.`);
      return false;
    });
    if (adding.length > 0 && !own) {
      summary.push(
        'Give the layout its own action bar: it showed Salesforce’s default actions, and will show only the ones listed here'
      );
    }
    for (const add of adding) {
      actions = [
        ...actions,
        { actionName: add.name.trim(), actionType: add.type ?? 'QuickAction', sortOrder: 0 },
      ];
      summary.push(`Add the action ${add.name.trim()}`);
    }
    next.platformActionList = {
      ...(own ?? { actionListContext: 'Record' }),
      platformActionListItems: actions.map((action, index) => ({ ...action, sortOrder: index })),
    };
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
