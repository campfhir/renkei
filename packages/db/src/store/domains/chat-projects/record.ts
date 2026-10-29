import type { Selectable } from 'kysely';
import type { ChatProjectMemories, ChatProjects } from '../../../db.types';
import { jsonOrNull } from '../chats/record';
import type {
  ChatProjectPatch,
  ChatProjectRecord,
  NewChatProject,
  ProjectMemoryRecord,
} from './types';

export function projectFromRow(row: Selectable<ChatProjects>): ChatProjectRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    kind: row.kind,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    toolConfig: row.tool_config ?? null,
    repoProvider: row.repo_provider,
    repoFullName: row.repo_full_name,
    repoBranch: row.repo_branch,
    workspaceId: row.workspace_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function projectMemoryFromRow(row: Selectable<ChatProjectMemories>): ProjectMemoryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    content: row.content,
    authorSubject: row.author_subject,
    chatId: row.chat_id,
    createdAt: new Date(row.created_at),
  };
}

export function newProjectValues(project: NewChatProject) {
  return {
    owner_subject: project.ownerSubject,
    name: project.name,
    description: project.description,
    instructions: null,
    tool_config: jsonOrNull(project.toolConfig),
    ...(project.repo
      ? {
          kind: 'code',
          repo_provider: project.repo.provider,
          repo_full_name: project.repo.fullName,
          repo_branch: project.repo.branch,
        }
      : {}),
  };
}

export function projectPatchValues(patch: ChatProjectPatch) {
  return {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    ...(patch.toolConfig !== undefined ? { tool_config: jsonOrNull(patch.toolConfig) } : {}),
    ...(patch.repo !== undefined
      ? {
          repo_provider: patch.repo.provider,
          repo_full_name: patch.repo.fullName,
          repo_branch: patch.repo.branch,
        }
      : {}),
    ...(patch.workspaceId !== undefined ? { workspace_id: patch.workspaceId } : {}),
  };
}
