/**
 * renkei_create_chat_project and renkei_create_code_project — a project
 * made from a chat, for the person in it, the way the Projects and Code
 * pages make one.
 *
 * renkei_list_projects is the look before either: every chat project and
 * code project the person can open — their own and the ones shared with
 * them, never the chats inside — with each code project's repository, so
 * the model can see a project is already there instead of making a second
 * one. The create tools hold the same line themselves: a code project on a
 * repository the person already has one on, or a chat project under a name
 * they already use, is refused with the existing project's link unless the
 * call says `allowDuplicate` — which is for the person asking for a second
 * one on purpose, not for retrying.
 *
 * Both create tools go through the functions those pages' routes call
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

import { getDataStore } from '@renkei/db';
import { CODE_HOSTS, createCodeProject } from '@/lib/code/create-project';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { listAccessibleProjectIds } from '../access';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from '../local-tools';
import {
  createProject,
  listProjectsById,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
  type ProjectRow,
} from '../projects';
import { optionalString } from '../route-support';
import { markdownLink } from './shared';

export const CREATE_CHAT_PROJECT_TOOL = 'renkei_create_chat_project';
export const CREATE_CODE_PROJECT_TOOL = 'renkei_create_code_project';
export const LIST_PROJECTS_TOOL = 'renkei_list_projects';

/** A project the person can open, with who shares it when it is not theirs. */
export interface OpenProject {
  project: ProjectRow;
  /** Null when the project is the person's own; else its owner's name, or their subject. */
  sharedBy: string | null;
}

/**
 * Every chat project and code project this person can open — the ones
 * they own and the ones shared with them — by name. Projects only: no
 * chat is read.
 */
export async function listOpenProjects(subject: string): Promise<OpenProject[]> {
  const projects = await listProjectsById(await listAccessibleProjectIds(subject), {
    orderBy: 'name',
  });
  const others = [
    ...new Set(
      projects.map((project) => project.ownerSubject).filter((owner) => owner !== subject)
    ),
  ];
  const identities =
    others.length > 0 ? await getDataStore().identities.listBySubjects(others) : [];
  const names = new Map(
    identities.map((row) => [row.subject, row.displayName ?? row.email ?? row.subject])
  );
  return projects.map((project) => ({
    project,
    sharedBy:
      project.ownerSubject === subject
        ? null
        : (names.get(project.ownerSubject) ?? project.ownerSubject),
  }));
}

const projectPath = (project: ProjectRow) =>
  project.kind === 'code' ? `/code/${project.id}` : `/chat/projects/${project.id}`;

const hostLabel = (provider: string) =>
  CODE_HOSTS.find((host) => host.provider === provider)?.label ?? provider;

/** `workspace/repo`, compared the way the hosts do: without regard to case. */
const sameRepo = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

function projectLine(context: LocalToolContext, { project, sharedBy }: OpenProject): string {
  const repo = project.repo
    ? ` on ${project.repo.fullName} (${hostLabel(project.repo.provider)}${project.repo.branch ? `, branch ${project.repo.branch}` : ''})`
    : '';
  return (
    `- ${markdownLink(context, project.name, projectPath(project))}: ` +
    `${project.kind === 'code' ? 'code project' : 'chat project'}${repo}; ` +
    `${sharedBy ? `shared by ${sharedBy}` : 'theirs'}` +
    `${project.description ? `; ${project.description}` : ''}`
  );
}

async function listProjects(input: Record<string, unknown>, context: LocalToolContext) {
  const kind = input.kind === 'chat' || input.kind === 'code' ? input.kind : null;
  const terms =
    typeof input.query === 'string' ? input.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const all = await listOpenProjects(context.subject);
  const shown = all.filter(({ project }) => {
    if (kind && project.kind !== kind) return false;
    const haystack =
      `${project.name} ${project.repo?.fullName ?? ''} ${project.description ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const what = kind === 'code' ? 'code project' : kind === 'chat' ? 'chat project' : 'project';
  if (shown.length === 0) {
    return textResult(
      terms.length > 0
        ? `No ${what} this person can open matches "${terms.join(' ')}" (of ${all.length} in all).`
        : `This person has no ${what}s yet, their own or shared with them.`
    );
  }
  return textResult(
    `${shown.length} ${what}(s) this person can open, their own and those shared with them:\n` +
      shown.map((entry) => projectLine(context, entry)).join('\n')
  );
}

/** The duplicate a create would make, said with where the existing one is. */
function alreadyThere(context: LocalToolContext, existing: OpenProject, what: string): string {
  const { project, sharedBy } = existing;
  return (
    `${what}: ${markdownLink(context, project.name, projectPath(project))}` +
    `${sharedBy ? `, shared by ${sharedBy}` : ''}. Nothing was made. ` +
    'Point the person to that one; pass allowDuplicate only if they asked for a second one on purpose.'
  );
}

const ALLOW_DUPLICATE = {
  type: 'boolean',
  description:
    'Make it even though the person already has one like it. Only when they asked for a second one on purpose.',
};

async function createChatProject(input: Record<string, unknown>, context: LocalToolContext) {
  const name = optionalString(input.name, PROJECT_NAME_MAX_CHARS);
  if (!name) return errorResult('Give the project a name. Nothing was made.');
  if (input.allowDuplicate !== true) {
    const existing = (await listOpenProjects(context.subject)).find(
      ({ project }) =>
        project.kind === 'chat' && project.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      return errorResult(
        alreadyThere(context, existing, `This person already has a chat project called "${name}"`)
      );
    }
  }
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
      description: `Make a chat project for this person: a shared workspace with its own instructions, memory and files that the chats inside it follow. Use it when they ask for a project to be set up. One under a name they already use is refused; ${LIST_PROJECTS_TOOL} shows what they have. Returns the link to open it.`,
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
          allowDuplicate: ALLOW_DUPLICATE,
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
      description: `Make a code project for this person on a ${labels} repository they can reach: a project whose chats work in a checkout of the repository, commit, push and open pull requests. Nothing is cloned until its first chat starts. Use it when they ask for a repository to be set up to work in; look the repository up first if they gave only part of its name. A repository they already have a code project on is refused, with that project's link; ${LIST_PROJECTS_TOOL} shows what they have, so check it first when setting up several. A .env is not taken here — they add it on the project's page. Returns the link to open it.`,
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
          allowDuplicate: ALLOW_DUPLICATE,
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
      if (input.allowDuplicate !== true && typeof input.repository === 'string') {
        const repository = input.repository;
        const existing = (await listOpenProjects(context.subject)).find(
          ({ project }) =>
            project.repo !== null &&
            project.repo.provider === host.provider &&
            sameRepo(project.repo.fullName, repository)
        );
        if (existing) {
          return errorResult(
            alreadyThere(
              context,
              existing,
              `This person already has a code project on ${existing.project.repo?.fullName ?? repository}`
            )
          );
        }
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

/** Found through find_tools, beside the tools that make a project. */
export function listProjectsTool(): LocalTool {
  return {
    readOnly: true,
    deferred: true,
    def: {
      name: LIST_PROJECTS_TOOL,
      description:
        "This person's projects in Renkei: every chat project and code project they can open, their own and the ones shared with them, each with its link and, for a code project, its repository and branch. Projects only, not the chats inside. Call it before making a project, to see whether one is already there, and to answer what projects they have. `kind` narrows to chat or code projects; `query` to a name or repository.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['chat', 'code'],
            description: 'Only chat projects, or only code projects. Leave out for both.',
          },
          query: {
            type: 'string',
            description: 'Words in the project name, its repository or its description.',
          },
        },
      },
    },
    execute: listProjects,
  };
}
