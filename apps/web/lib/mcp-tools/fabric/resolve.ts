/**
 * References as a person gives them — an id, or a name exactly as Fabric
 * shows it — resolved to the object. A name that matches more than one is
 * refused with the ids rather than guessed at: these tools create and
 * overwrite, and the wrong "Sales" workspace is a real cost.
 */

import { asRecord } from '@renkei/guards';
import {
  fabricCall,
  fabricList,
  isGuid,
  str,
  type FabricAccess,
  type FabricCallContext,
} from './client';

export interface Workspace {
  id: string;
  displayName: string;
  description: string;
  type: string;
  capacityId: string;
}

export interface Item {
  id: string;
  displayName: string;
  description: string;
  type: string;
  workspaceId: string;
}

export function workspaceOf(raw: Record<string, unknown>): Workspace {
  return {
    id: str(raw.id),
    displayName: str(raw.displayName),
    description: str(raw.description),
    type: str(raw.type),
    capacityId: str(raw.capacityId),
  };
}

export function itemOf(raw: Record<string, unknown>): Item {
  return {
    id: str(raw.id),
    displayName: str(raw.displayName),
    description: str(raw.description),
    type: str(raw.type),
    workspaceId: str(raw.workspaceId),
  };
}

function pick<T extends { id: string; displayName: string }>(
  candidates: T[],
  ref: string,
  what: string
): T | string {
  const wanted = ref.trim().toLowerCase();
  const matches = candidates.filter((c) => c.displayName.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return `No ${what} named "${ref}" that you can see.`;
  return (
    `More than one ${what} is named "${ref}"; say which by id: ` +
    matches.map((m) => m.id).join(', ')
  );
}

/** A workspace by id or exact name. */
export async function resolveWorkspace(
  context: FabricCallContext,
  access: FabricAccess,
  ref: string
): Promise<Workspace | string> {
  if (isGuid(ref)) {
    const answer = await fabricCall(context, access, 'GET', `/workspaces/${ref.trim()}`);
    return answer.ok ? workspaceOf(answer.body) : `Workspace ${ref}: ${answer.error}`;
  }
  const listed = await fabricList(context, access, '/workspaces');
  if (!listed.ok) return `Could not list workspaces: ${listed.error}`;
  return pick(listed.values.map(workspaceOf), ref, 'workspace');
}

/** An item of one type in a workspace, by id or exact name. */
export async function resolveItem(
  context: FabricCallContext,
  access: FabricAccess,
  workspace: Workspace,
  type: 'Notebook' | 'DataPipeline' | 'Lakehouse',
  ref: string
): Promise<Item | string> {
  const what = TYPE_LABEL[type];
  if (isGuid(ref)) {
    const answer = await fabricCall(
      context,
      access,
      'GET',
      `/workspaces/${workspace.id}/items/${ref.trim()}`
    );
    if (!answer.ok) return `${what} ${ref}: ${answer.error}`;
    const item = itemOf(answer.body);
    return item.type === type ? item : `${ref} is a ${item.type}, not a ${what}.`;
  }
  const listed = await fabricList(
    context,
    access,
    `/workspaces/${workspace.id}/items?type=${type}`
  );
  if (!listed.ok) return `Could not list ${what}s in "${workspace.displayName}": ${listed.error}`;
  return pick(listed.values.map(itemOf), ref, `${what} in "${workspace.displayName}"`);
}

/** A capacity by id or exact name, among those the person may use. */
export async function resolveCapacity(
  context: FabricCallContext,
  access: FabricAccess,
  ref: string
): Promise<{ id: string; displayName: string; sku: string; region: string } | string> {
  const listed = await fabricList(context, access, '/capacities');
  if (!listed.ok) return `Could not list capacities: ${listed.error}`;
  const capacities = listed.values.map((raw) => ({
    id: str(raw.id),
    displayName: str(raw.displayName),
    sku: str(raw.sku),
    region: str(raw.region),
    state: str(asRecord(raw).state),
  }));
  if (isGuid(ref)) {
    const found = capacities.find((c) => c.id.toLowerCase() === ref.trim().toLowerCase());
    return found ?? `No capacity ${ref} that you may assign workspaces to.`;
  }
  return pick(capacities, ref, 'capacity');
}

export const TYPE_LABEL: Record<string, string> = {
  Notebook: 'notebook',
  DataPipeline: 'data pipeline',
  Lakehouse: 'lakehouse',
};
