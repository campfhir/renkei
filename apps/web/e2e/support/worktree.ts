/**
 * A seeded code chat's worktree on the sandbox stub: the checkout the
 * chat's pane and tools work in. lib/code/turn.ts makes one on a chat's
 * first turn; a spec that opens the pane without running a turn gives the
 * chat one here the way that turn would — asked of the sandbox worker,
 * then recorded with `chats.setWorkspace` (e2e/worktree.ts did the latter
 * in SQL).
 */

import type { APIRequestContext } from '@playwright/test';
import { dataStore } from './store';

const SANDBOX_URL = process.env.SANDBOX_WORKER_URL ?? 'http://127.0.0.1:8092';
const SANDBOX_KEY = process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key';

export async function giveChatWorktree(
  request: APIRequestContext,
  input: { projectId: string; baseId: string; chatId: string }
): Promise<string> {
  const made = await request.post(`${SANDBOX_URL}/v1/workspaces/worktree`, {
    headers: { authorization: `Bearer ${SANDBOX_KEY}` },
    data: {
      subject: `code-project:${input.projectId}`,
      baseId: input.baseId,
      branch: `renkei/${input.chatId.slice(-12)}`,
    },
  });
  if (!made.ok()) throw new Error(`the sandbox stub answered ${made.status()}`);
  const body: unknown = await made.json();
  const workspace =
    typeof body === 'object' && body !== null && 'workspace' in body ? body.workspace : null;
  const id =
    typeof workspace === 'object' && workspace !== null && 'id' in workspace ? workspace.id : null;
  if (typeof id !== 'string') throw new Error('the sandbox stub made no worktree');
  await dataStore(request).chats.setWorkspace(input.chatId, id);
  return id;
}
