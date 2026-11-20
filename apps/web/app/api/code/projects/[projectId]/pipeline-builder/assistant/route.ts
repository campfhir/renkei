/**
 * POST: ask the pipeline builder's assistant (lib/ci/pipeline-assistant.ts)
 * — the conversation so far and the pipeline as the builder has it now.
 * It answers 202 { jobId } at once and works the answer out in the
 * background (lib/ci/assistant-jobs.ts); the page asks
 * GET …/assistant/[jobId] for its steps and, at the end, the reply and any
 * proposal it applies on the person's word. It reads the repository with
 * the person's own grant on the host and writes nothing: no pipeline is
 * saved, no block made.
 *
 * Editors only (a viewer cannot apply what it proposes). An operator is
 * also offered the tool that makes one of the project's blocks into a
 * building block for every project; the page saves that through the
 * catalogue's own route (POST /api/admin/ci-blocks), as a draft.
 *
 *   POST { conversation: [{ role, text }], spec } → 202 { jobId }
 */

import type { NextRequest } from 'next/server';
import { NextResponse, after } from 'next/server';
import { randomUUID } from 'node:crypto';
import { resolveAgentLlm } from '@renkei/agent-llm';
import { readPipelineSpec } from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { preferredChatModelId } from '@/lib/chat/preferred-model';
import {
  bitbucketAuthOf,
  listSource as listBitbucketSource,
  readSourceFile as readBitbucketFile,
} from '@/lib/code/bitbucket-browse';
import {
  githubAuthOf,
  listSource as listGithubSource,
  readSourceFile as readGithubFile,
} from '@/lib/code/github-browse';
import { readConversation } from '@/lib/ci/pipeline-assistant';
import { meteredComplete, runAssistantJob, startAssistantJob } from '@/lib/ci/assistant-jobs';
import { builderBlocks, builderTargets, withBranch } from '@/lib/ci/pipeline-builder';
import { builderContext } from '@/lib/ci/pipeline-builder-access';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { subject, origin, host } = found.context;
  const body = await readJsonBody(request);
  const conversation = readConversation(body.conversation);
  if ('error' in conversation) return jsonError(400, 'conversation', conversation.error);
  if (!isRecord(body.spec)) return jsonError(400, 'spec', 'Send the pipeline in the builder.');
  // A pipeline that does not read yet is when help is wanted most: the
  // assistant gets it as it stands, with what is wrong, and must fix it.
  const spec = readPipelineSpec(body.spec);

  const resolved = await resolveAgentLlm(
    await preferredChatModelId(subject, found.context.project.id)
  );
  if (!resolved.ok) {
    return jsonError(
      409,
      'no-model',
      'No model is set up for the organization; an admin adds one under Agent models.'
    );
  }
  const llm = resolved.val;
  const operator = (await checkAccess([ROLE_OPERATOR])) !== null;
  const caller = { subject, origin };
  const following = found.context.project;
  const jobId = randomUUID();
  await startAssistantJob(jobId, subject, following.id, new Date());

  // The answer is worked out after this response: the page asks for the
  // job (…/assistant/[jobId]) rather than holding this request open.
  after(() =>
    runAssistantJob(
      jobId,
      { subject, project: following.name, repository: following.repo.fullName },
      async () => {
        const project = await withBranch(caller, following);
        const { fullName, branch } = project.repo;
        const [blocks, targets] = await Promise.all([
          builderBlocks(spec.ok ? spec.value : null),
          builderTargets(),
        ]);
        return {
          input: {
            conversation,
            spec: spec.ok ? spec.value : body.spec,
            specProblems: spec.ok ? [] : spec.errors,
            host,
            repo: fullName,
            branch,
            blocks,
            targets,
            operator,
          },
          deps: {
            complete: meteredComplete(llm, subject),
            maxOutputTokens: llm.maxOutputTokens,
            listFiles: (path) =>
              host === 'github'
                ? listGithubSource(githubAuthOf(caller), fullName, branch, path)
                : listBitbucketSource(bitbucketAuthOf(caller), fullName, branch, path),
            readFile: (path) =>
              host === 'github'
                ? readGithubFile(githubAuthOf(caller), fullName, branch, path)
                : readBitbucketFile(bitbucketAuthOf(caller), fullName, branch, path),
          },
        };
      }
    )
  );
  return NextResponse.json({ jobId }, { status: 202 });
}
