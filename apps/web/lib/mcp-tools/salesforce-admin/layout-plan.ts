/**
 * Planning a page-layout change for a proposal: read the live layout whole,
 * merge the change (@renkei/connector-salesforce layouts.ts), and return
 * what the package carries for it — the whole layout file, its member, the
 * review page's component, and the precondition that it has not moved
 * since it was read. A layout deploys whole, so the merge is the change.
 */

import {
  layoutSections,
  mergeLayoutChanges,
  metadataFile,
  metadataFileName,
  type LayoutChanges,
  type PackageMember,
} from '@renkei/connector-salesforce';
import type { SalesforceAccess, SalesforceCallContext } from '../salesforce/client';
import { readLayout, type ComponentView, type Precondition } from '@/lib/salesforce-admin/plan';

export interface LayoutPart {
  /** The layout's name as people see it. */
  name: string;
  path: string;
  content: string;
  member: PackageMember;
  component: ComponentView;
  precondition: Precondition;
  summary: string[];
}

export async function planLayoutChange(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  layoutName: string | undefined,
  changes: LayoutChanges
): Promise<LayoutPart | string> {
  const live = await readLayout(context, access, object, layoutName);
  if (typeof live === 'string') return live;
  const merged = mergeLayoutChanges(live.metadata, changes);
  if (!merged.ok) return `The layout “${live.name}”: ${merged.errors.join(' ')}`;
  const after = layoutSections(merged.layout)
    .filter((section) => section.columns.some((column) => column.length > 0))
    .map(
      (section) =>
        `${section.label}: ${section.columns.map((c) => c.join(', ') || '—').join(' | ')}`
    );
  return {
    name: live.name,
    path: `layouts/${metadataFileName(live.fullName)}.layout`,
    content: metadataFile('Layout', merged.layout),
    member: { type: 'Layout', member: live.fullName },
    component: {
      type: 'Layout',
      name: live.fullName,
      action: 'update',
      rows: [
        ...merged.summary.map((line) => ({ label: 'Change', value: line })),
        ...after.map((line) => ({ label: 'Then reads', value: line })),
      ],
    },
    precondition: {
      kind: 'layout-unchanged',
      object,
      layout: live.name,
      fingerprint: live.fingerprint,
    },
    summary: merged.summary.map((line) => `  ${live.name}: ${line}`),
  };
}
