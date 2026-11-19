/**
 * POST: one turn of the pipeline builder's assistant
 * (lib/ci/pipeline-assistant.ts) — the conversation so far and the
 * pipeline as the builder has it now; the answer is the assistant's
 * reply and, when it has one, a proposal the page applies on the
 * person's word. It reads the repository with the person's own grant on
 * the host and writes nothing: no pipeline is saved, no block made.
 *
 * Editors only (a viewer cannot apply what it proposes). An operator is
 * also offered the tool that makes one of the project's blocks into a
 * building block for every project; the page saves that through the
 * catalogue's own route (POST /api/admin/ci-blocks), as a draft.
 *
 *   POST { conversation: [{ role, text }], spec } →
 *     { reply, proposal: { summary, spec, unfinished } | null,
 *       buildingBlock: { key, name, description, kind, definition, from } | null,
 *       read: string[] }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveAgentLlm } from '@renkei/agent-llm';
import { readPipelineSpec } from '@renkei/ci-blocks';
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
import { readConversation, runPipelineAssistant } from '@/lib/ci/pipeline-assistant';
import { builderBlocks, builderTargets } from '@/lib/ci/pipeline-builder';
import { builderContext } from '@/lib/ci/pipeline-builder-access';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, origin, host } = found.context;
  const body = await readJsonBody(request);
  const conversation = readConversation(body.conversation);
  if ('error' in conversation) return jsonError(400, 'conversation', conversation.error);
  const spec = readPipelineSpec(body.spec);
  if (!spec.ok) {
    return NextResponse.json(
      { error: 'The pipeline in the builder does not read.', problems: spec.errors },
      { status: 400 }
    );
  }

  const resolved = await resolveAgentLlm(await preferredChatModelId(subject, project.id));
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
  const { fullName, branch } = project.repo;
  const [blocks, targets] = await Promise.all([builderBlocks(spec.value), builderTargets()]);

  const reply = await runPipelineAssistant(
    {
      conversation,
      spec: spec.value,
      host,
      repo: fullName,
      branch,
      blocks,
      targets,
      operator,
    },
    {
      complete: (llmRequest) => llm.provider.complete(llmRequest),
      maxOutputTokens: llm.maxOutputTokens,
      listFiles: (path) =>
        host === 'github'
          ? listGithubSource(githubAuthOf(caller), fullName, branch, path)
          : listBitbucketSource(bitbucketAuthOf(caller), fullName, branch, path),
      readFile: (path) =>
        host === 'github'
          ? readGithubFile(githubAuthOf(caller), fullName, branch, path)
          : readBitbucketFile(bitbucketAuthOf(caller), fullName, branch, path),
    }
  );
  if ('error' in reply) {
    logger.warn(
      '{actor} asked the pipeline assistant of the project "{project}" ({repository}), but the model did not answer; nothing was proposed: {error}',
      {
        component: 'api/code/projects/pipeline-builder/assistant',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: fullName,
        error: reply.error,
      }
    );
    return jsonError(502, 'model', reply.error);
  }
  logger.info(
    '{actor} asked the pipeline assistant of the project "{project}" ({repository}); it read {reads} paths and proposed {proposed}',
    {
      component: 'api/code/projects/pipeline-builder/assistant',
      ...(await whoIs(subject)),
      projectId,
      project: project.name,
      repository: fullName,
      reads: reply.read.length,
      proposed:
        [reply.proposal ? 'a pipeline' : '', reply.buildingBlock ? 'a building block' : '']
          .filter(Boolean)
          .join(' and ') || 'nothing',
    }
  );
  return NextResponse.json(reply);
}
