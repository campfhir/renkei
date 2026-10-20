/**
 * A seeded code chat's worktree on the sandbox stub: the checkout the
 * chat's pane and tools work in (lib/code/turn.ts makes one on a chat's
 * first turn; a spec that opens the pane without running a turn gives the
 * chat one here, the way that turn would have).
 */

import type { Client } from 'pg';

export async function giveChatWorktree(
  client: Client,
  input: { projectId: string; baseId: string; chatId: string }
): Promise<string> {
  const worker = process.env.SANDBOX_WORKER_URL ?? 'http://127.0.0.1:8092';
  const made = await fetch(`${worker}/v1/workspaces/worktree`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key'}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      subject: `code-project:${input.projectId}`,
      baseId: input.baseId,
      branch: `renkei/${input.chatId.slice(-12)}`,
    }),
  });
  const { workspace }: { workspace: { id: string } } = await made.json();
  await client.query('UPDATE chats SET workspace_id = $1 WHERE id = $2', [
    workspace.id,
    input.chatId,
  ]);
  return workspace.id;
}
