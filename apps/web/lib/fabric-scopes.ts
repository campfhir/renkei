/**
 * The Microsoft Fabric delegated scopes Renkei's Fabric connector uses —
 * grouped checkboxes via ScopePicker, the entra-developer-scopes.ts shape.
 * Pure data, importable from client components; the server config reader
 * re-exports the default.
 *
 * Fabric is its own resource in Entra (api.fabric.microsoft.com), so its
 * scopes are named with the resource in front — `https://api.fabric.microsoft.com/Workspace.Read.All`
 * — and a token minted for them carries no Graph scope at all. That is why
 * the required set below has no User.Read: asking for a Graph scope in the
 * same consent would make Entra refuse the request ("scopes from more than
 * one resource"). Who connected is read from the id_token instead.
 *
 * Fabric's tokens name their scopes without the resource prefix (scp:
 * "Workspace.Read.All Notebook.ReadWrite.All"); `shortFabricScope` makes
 * the two spellings comparable wherever a grant is checked.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const FABRIC_RESOURCE = 'https://api.fabric.microsoft.com/';

/** A Fabric scope as the API names it, with the resource in front. */
export const fabricScope = (name: string): string => `${FABRIC_RESOURCE}${name}`;

/** A scope as Fabric's tokens name it: the resource prefix dropped. */
export function shortFabricScope(scope: string): string {
  return scope.startsWith(FABRIC_RESOURCE) ? scope.slice(FABRIC_RESOURCE.length) : scope;
}

export const FABRIC_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'browse', label: 'Browsing' },
  { id: 'build', label: 'Building' },
];

export const FABRIC_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'Workspace.Read.All',
    scopes: [fabricScope('Workspace.Read.All'), fabricScope('Item.Read.All')],
    label: 'See workspaces and their items',
    hint:
      'fabric_list_workspaces, fabric_get_workspace, fabric_list_items (notebooks, data ' +
      'pipelines, lakehouses, warehouses, reports… in a workspace), fabric_get_operation. ' +
      'Only the workspaces the person has a role in.',
    userHint:
      'See the Fabric workspaces you have a role in and what is in them — notebooks, data ' +
      'pipelines, lakehouses and the rest.',
    group: 'browse',
    defaultChecked: true,
  },
  {
    id: 'Lakehouse.Read.All',
    scopes: [fabricScope('Lakehouse.Read.All')],
    label: 'See lakehouse tables',
    hint:
      'fabric_list_tables — a lakehouse’s tables (name, managed or external, format, ' +
      'location). Names and shapes only: no rows are read.',
    userHint: 'See the tables in your lakehouses — their names and formats, not their data.',
    group: 'browse',
    defaultChecked: true,
  },
  {
    id: 'Capacity.Read.All',
    scopes: [fabricScope('Capacity.Read.All')],
    label: 'See capacities',
    hint:
      'fabric_list_capacities — the capacities the person may assign a workspace to, so ' +
      'fabric_create_workspace_preview can put a new workspace on one by name.',
    userHint: 'See which Fabric capacities you can put a new workspace on.',
    group: 'browse',
    defaultChecked: true,
  },
  {
    id: 'Workspace.ReadWrite.All',
    scopes: [fabricScope('Workspace.Read.All'), fabricScope('Workspace.ReadWrite.All')],
    label: 'Create and change workspaces',
    hint:
      'fabric_create_workspace_preview, fabric_update_workspace_preview (name, description) — ' +
      'each preview + confirm on a card. Fabric still checks that the person may create ' +
      'workspaces and is an admin of the one being changed.',
    userHint:
      'Create Fabric workspaces and rename or re-describe ones you administer — each change ' +
      'confirmed by you on a card first.',
    group: 'build',
    defaultChecked: true,
  },
  {
    id: 'Notebook.ReadWrite.All',
    scopes: [fabricScope('Workspace.Read.All'), fabricScope('Notebook.ReadWrite.All')],
    label: 'Read, create and edit notebooks',
    hint:
      'fabric_get_notebook_definition (the notebook as Jupyter .ipynb — Fabric serves ' +
      'definitions as a long-running operation, so this may finish later and notify the ' +
      'person), fabric_create_notebook_preview, fabric_update_notebook_preview (rename, ' +
      'describe, replace its content) — writes preview + confirm. Fabric requires ' +
      'read-and-write access even to read a definition.',
    userHint:
      'Read your notebooks’ code, create notebooks and change them — each change confirmed ' +
      'by you on a card first.',
    group: 'build',
    defaultChecked: true,
  },
  {
    id: 'DataPipeline.ReadWrite.All',
    scopes: [fabricScope('Workspace.Read.All'), fabricScope('DataPipeline.ReadWrite.All')],
    label: 'Read, create and edit data pipelines',
    hint:
      'fabric_get_pipeline_definition (its activities as JSON, a long-running operation like ' +
      'a notebook’s), fabric_create_pipeline_preview, fabric_update_pipeline_preview — writes ' +
      'preview + confirm.',
    userHint:
      'Read your data pipelines’ activities, create pipelines and change them — each change ' +
      'confirmed by you on a card first.',
    group: 'build',
    defaultChecked: true,
  },
];

/**
 * Always requested, never a choice: identity claims for the callback and
 * offline_access for a refresh token. No User.Read — see the header.
 */
export const FABRIC_REQUIRED_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

export const DEFAULT_FABRIC_SCOPES = [
  ...new Set([
    ...FABRIC_SCOPE_OPTIONS.flatMap((option) => option.scopes),
    ...FABRIC_REQUIRED_SCOPES,
  ]),
].join(' ');
