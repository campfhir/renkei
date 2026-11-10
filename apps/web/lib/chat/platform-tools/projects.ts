/**
 * renkei_create_chat_project and renkei_create_code_project — a project
 * made from a chat, for the person in it, the way the Projects and Code
 * pages make one.
 *
 * Both go through the functions those pages' routes call
 * (projects.ts's createProject, lib/code/create-project.ts), so a project
 * made here is owned by the person, sealed under its own key and audited
 * exactly as one made by hand. Both act, so the chat asks first.
 *
 * The code project tool exists only where it can work (index.ts): the
 * deployment runs code workspaces AND the person has a Bitbucket or GitHub
 * connection that can clone, push and open pull requests
 * (lib/code/access.ts) — the bar the Code page holds "New code project"
 * to. Its `provider` is one of the hosts that clear it. A `.env` is never
 * taken here: secrets do not belong in a chat, and the project's page has
 * the field for it.
 */

import { createCodeProject } from '@/lib/code/create-project';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from '../local-tools';
import { createProject, PROJECT_INSTRUCTIONS_MAX_CHARS, PROJECT_NAME_MAX_CHARS } from '../projects';
import { optionalString } from '../route-support';
import { markdownLink } from './shared';

export const CREATE_CHAT_PROJECT_TOOL = 'renkei_create_chat_project';
export const CREATE_CODE_PROJECT_TOOL = 'renkei_create_code_project';

async function createChatProject(input: Record<string, unknown>, context: LocalToolContext) {
  const name = optionalString(input.name, PROJECT_NAME_MAX_CHARS);
  if (!name) return errorResult('Give the project a name. Nothing was made.');
  const description = optionalString(input.description, 2_000) || null;
  const instructions = optionalString(input.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS) || null;
  const projectId = await createProject({
    ownerSubject: context.subject,
    name,
    description,
    instructions,
    toolConfig: null,
  });
  if (!projectId) {
    logger.error(
      '{actor} asked a chat to make the project "{name}", but the content encryption key is not configured; the project was not saved',
      {
        component: 'chat/platform-tools',
        ...(context.actor ?? (await whoIs(context.subject))),
        chatId: context.chatId,
        name,
      }
    );
    return errorResult(
      'The project was not made: the content encryption key is not configured on this deployment. Tell the person it failed.'
    );
  }
  return textResult(
    `Made the chat project "${name}"${instructions ? ', with its instructions' : ''}. ` +
      `It is theirs alone until they share it. Open it: ${markdownLink(context, name, `/chat/projects/${projectId}`)}. ` +
      'This chat stays where it is; a chat is started in or moved into the project from its page.'
  );
}

/** One host that clears the Code page's bar for this person. */
export interface CodeHost {
  provider: string;
  label: string;
}

export function chatProjectTool(): LocalTool {
  return {
    deferred: true,
    def: {
      name: CREATE_CHAT_PROJECT_TOOL,
      description:
        'Make a chat project for this person: a shared workspace with its own instructions, memory and files that the chats inside it follow. Use it when they ask for a project to be set up. Returns the link to open it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What the project is called.' },
          description: { type: 'string', description: 'A line saying what it is for.' },
          instructions: {
            type: 'string',
            description:
              'Standing instructions every chat in the project follows. Leave out for none.',
          },
        },
        required: ['name'],
      },
    },
    execute: createChatProject,
  };
}

/** `hosts` are the git hosts this person's connections can make a code project on; never empty. */
export function codeProjectTool(hosts: readonly CodeHost[]): LocalTool {
  const labels = hosts.map((host) => host.label).join(' or ');
  return {
    deferred: true,
    def: {
      name: CREATE_CODE_PROJECT_TOOL,
      description: `Make a code project for this person on a ${labels} repository they can reach: a project whose chats work in a checkout of the repository, commit, push and open pull requests. Nothing is cloned until its first chat starts. Use it when they ask for a repository to be set up to work in; look the repository up first if they gave only part of its name. A .env is not taken here — they add it on the project's page. Returns the link to open it.`,
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: hosts.map((host) => host.provider),
            description: `The git host: ${hosts.map((host) => `${host.provider} (${host.label})`).join(', ')}.`,
          },
          repository: {
            type: 'string',
            description: 'The repository as the host names it: workspace/repo or owner/repo.',
          },
          branch: {
            type: 'string',
            description: "The branch to work from. Leave out for the repository's default.",
          },
          name: {
            type: 'string',
            description: "The project's name. Leave out to use the repository's.",
          },
          description: { type: 'string', description: 'A line saying what it is for.' },
          instructions: {
            type: 'string',
            description:
              "Standing instructions for the project's chats. Leave out for the standard developer's brief.",
          },
        },
        required: ['provider', 'repository'],
      },
    },
    async execute(input, context) {
      const host = hosts.find((entry) => entry.provider === input.provider);
      if (!host) {
        return errorResult(
          `provider must be one of: ${hosts.map((entry) => entry.provider).join(', ')}. Nothing was made.`
        );
      }
      // Only what this tool's schema names reaches the creator: no .env, no toolset.
      const body: Record<string, unknown> = {
        provider: host.provider,
        repository: input.repository,
      };
      for (const key of ['branch', 'name', 'description', 'instructions'] as const) {
        if (typeof input[key] === 'string' && input[key].trim()) body[key] = input[key];
      }
      const created = await createCodeProject(
        context.subject,
        context.actor ?? (await whoIs(context.subject)),
        body
      );
      if (!created.ok) return errorResult(`${created.message} Nothing was made.`);
      return textResult(
        `Made the code project "${created.name}" on ${created.repository} (${host.label}). ` +
          `The repository is cloned when its first chat starts. Open it: ${markdownLink(context, created.name, `/code/${created.projectId}`)}`
      );
    },
  };
}
