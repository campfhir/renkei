/**
 * Every act tool's preview builder, by tool name.
 *
 * Each domain file owns its tools; this merges them and refuses a name
 * given twice. act-preview.ts generates the preview/confirm pair for every
 * tool named here, and a test fails when an act tool that should have a
 * card does not appear — a new act tool arrives with its card or not at all.
 */

import type { PreviewBuilder } from './card';
import { CONFLUENCE_PREVIEWS } from './confluence';
import { DOCUMENT_PREVIEWS } from './documents';
import { INTEGRATION_PREVIEWS } from './integrations';
import { JIRA_PREVIEWS } from './jira';
import { JSM_PREVIEWS } from './jsm';
import { MEETING_PREVIEWS } from './meetings';
import { MIRTH_ADMIN_PREVIEWS } from './mirth-admin';
import { OUTLOOK_PREVIEWS } from './outlook';
import { SOURCE_CONTROL_PREVIEWS } from './source-control';

const SETS: Record<string, PreviewBuilder>[] = [
  JIRA_PREVIEWS,
  JSM_PREVIEWS,
  CONFLUENCE_PREVIEWS,
  SOURCE_CONTROL_PREVIEWS,
  OUTLOOK_PREVIEWS,
  MEETING_PREVIEWS,
  DOCUMENT_PREVIEWS,
  INTEGRATION_PREVIEWS,
  MIRTH_ADMIN_PREVIEWS,
];

function merge(): Record<string, PreviewBuilder> {
  const merged: Record<string, PreviewBuilder> = {};
  for (const set of SETS) {
    for (const [name, builder] of Object.entries(set)) {
      if (name in merged) throw new Error(`Two preview builders for ${name}`);
      merged[name] = builder;
    }
  }
  return merged;
}

export const PREVIEW_BUILDERS: Readonly<Record<string, PreviewBuilder>> = merge();
