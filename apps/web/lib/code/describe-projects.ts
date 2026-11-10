/**
 * Fills in the description of code projects that have none, from the
 * repository's README, with the owner's own access to the git host. Run
 * after a response (`after()`), never in it. A project whose host does not
 * answer, or whose README has no prose, is left as it is and tried again
 * on a later visit.
 */

import { getProjectRow, updateProject, type ProjectRow } from '@/lib/chat/projects';
import { loadCodeReadme } from './project-view';
import { summarizeReadme } from './readme-summary';

/** At most this many projects are read per visit, a few at a time. */
const BATCH = 10;
const PARALLEL = 3;

export async function describeProjectsFromReadme(
  ownerSubject: string,
  projects: Pick<ProjectRow, 'id'>[]
): Promise<number> {
  const queue = projects.slice(0, BATCH);
  let filled = 0;
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        const project = await getProjectRow(next.id);
        if (!project || project.ownerSubject !== ownerSubject || !project.repo) continue;
        if (project.description?.trim()) continue;
        const readme = await loadCodeReadme(ownerSubject, project);
        const description = readme ? summarizeReadme(readme.text) : null;
        if (!description) continue;
        // Written only while still empty: a description typed meanwhile wins.
        const fresh = await getProjectRow(project.id);
        if (fresh?.description?.trim()) continue;
        if (await updateProject(project.id, { description, keepUpdatedAt: true })) filled += 1;
      } catch {
        // A host that errors costs this project its fill this visit.
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return filled;
}
