/**
 * Everything the owner-facing run page renders below the header, fetched
 * together so the initial page load and every later live-stream refresh
 * read the exact same projection — one function, one set of rules, instead
 * of the page's server component and the stream route each growing their
 * own copy of the pause-card query.
 */

import { getDataStore } from '@renkei/db';
import { parseFormNodes, type FormNode } from '@renkei/agents';
import { getRunForOwner, type RunDetail } from './runs-view';

export interface PauseCardView {
  id: string;
  kind: string;
  status: string;
  summary: string;
}

export interface OwnerRunPageData {
  run: RunDetail;
  pauseCard: PauseCardView | null;
  questionForm: FormNode[];
}

/** The `form` field a question card's suggested_action carries, if any. */
function formFieldOf(suggestedAction: unknown): unknown {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return undefined;
  const record: { form?: unknown } =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
    suggestedAction as { form?: unknown };
  return record.form;
}

export async function getOwnerRunPageData(
  ownerSubject: string,
  viewerIsOwner: boolean,
  agentId: string,
  runId: string
): Promise<OwnerRunPageData | null> {
  const run = await getRunForOwner(ownerSubject, agentId, runId);
  if (!run) return null;

  // The run page mirrors the home-page pause card while the run waits, so
  // the person reading the timeline can decide right here. The card is
  // the OWNER's decision to make — approving spends their grants — so a
  // grantee reads the timeline without it.
  const pauseCardRow =
    viewerIsOwner && run.status === 'waiting'
      ? await getDataStore().agentRuns.findPauseCard(runId, ownerSubject)
      : null;

  return {
    run,
    pauseCard: pauseCardRow
      ? {
          id: pauseCardRow.id,
          kind: pauseCardRow.kind,
          status: pauseCardRow.status,
          summary: pauseCardRow.summary,
        }
      : null,
    questionForm:
      pauseCardRow?.kind === 'question'
        ? parseFormNodes(formFieldOf(pauseCardRow.suggestedAction))
        : [],
  };
}
