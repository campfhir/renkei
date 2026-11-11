/**
 * What the chat's Pipelines dialog (pipelines-modal.tsx) decides before
 * it draws anything: which host's panel the project gets, from the
 * project's own answer, and what the dialog is called. Tested in
 * pipelines-modal.model.test.ts.
 */

import { isRecord } from '@renkei/guards';

export interface PipelinesTarget {
  /** The provider-grants constant for the repository's host. */
  provider: string;
  repoFullName: string;
  /** The project's branch; empty for the repository's default. */
  branch: string;
  /** An editor or owner; a viewer reads. */
  canEdit: boolean;
}

/** The target out of a code project's page data (`GET /api/code/projects/[id]`); null when it does not name a repository. */
export function projectHostOf(data: unknown): PipelinesTarget | null {
  if (!isRecord(data) || !isRecord(data.code)) return null;
  const { repoProvider, repoFullName, branch } = data.code;
  if (typeof repoProvider !== 'string' || typeof repoFullName !== 'string' || !repoFullName) {
    return null;
  }
  return {
    provider: repoProvider,
    repoFullName,
    branch: typeof branch === 'string' ? branch : '',
    canEdit: data.role === 'owner' || data.role === 'editor',
  };
}

/**
 * Which panel the project gets: GitHub's Actions page, Bitbucket's
 * Pipelines page, or none for a host with neither. The provider names are
 * the stored ones (lib/code/projects.ts) as literals — this runs in the
 * browser, which cannot carry the provider-grants package.
 */
export function panelFor(target: PipelinesTarget): 'actions' | 'pipelines' | null {
  if (target.provider === 'github') return 'actions';
  if (target.provider === 'atlassian-bitbucket') return 'pipelines';
  return null;
}

/** GitHub calls it Actions; Bitbucket, and the dialog before it knows, Pipelines. */
export function modalTitle(target: PipelinesTarget | null): string {
  return target && panelFor(target) === 'actions' ? 'Actions' : 'Pipelines';
}
