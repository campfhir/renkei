/**
 * The chat's own tools, chosen per turn from what the chat has: reading
 * and staging its attachments, writing a file for the person to keep,
 * remembering things for its project or (outside a project) for the
 * person across every chat they own, recalling their other chats,
 * showing a mockup inline (mockup-tools.ts), settling its preview cards
 * on the person's word (widget-state-tools.ts),
 * and compacting its own history (chat_compact, offered unconditionally —
 * see below). Each of the others is registered only when it can do something — no project, no
 * project memory tools; a chat in a project, no personal memory or recall
 * tools either, since a project is self-contained and does not reach
 * outside itself; no attachments, no attachment tools; no file store, no
 * writing; no chart renderer, no charts; no sandbox in the toolset, no
 * doors to it (sandbox-file-tools.ts) — so the model is never offered a
 * verb that can only fail.
 */

import { getDataStore } from '@renkei/db';
import type { LocalTool, LocalToolContext } from './local-tools';
import type { ChatToolConfig } from './tool-config';
import { sandboxChartsEnabled, sandboxConfig, sandboxScriptsServed } from '@renkei/sandbox-client';
import { attachmentTools } from './attachment-tools';
import { compactionTools } from './compaction-tools';
import { chartTools } from './chart-tools';
import { chatRenameTool } from './chat-title-tools';
import { fileTools } from './file-tools';
import { memoryTools } from './memory-tools';
import { mockupTools } from './mockup-tools';
import { userMemoryTools } from './user-memory-tools';
import { recallTools } from './recall-tools';
import { artifactDescribeTool, artifactTools } from './artifact-tools';
import { sandboxFileTools } from './sandbox-file-tools';
import { getImagePrefs } from '@renkei/user-prefs';
import { imageGenerationTool } from './image-tools';
import { listImageModels } from './models';
import { widgetStateTools } from './widget-state-tools';

export async function chatLocalTools(
  context: LocalToolContext,
  toolConfig: ChatToolConfig,
  /** The org has somewhere to keep files; without one nothing written could be kept. */
  filesAllowed: boolean
): Promise<LocalTool[]> {
  // chat_compact acts on the chat's own stored messages, never an
  // organization system, so every chat gets it — no project or
  // read-only gate, unlike the tools below.
  const tools: LocalTool[] = [...compactionTools(), chatRenameTool()];
  // A mockup is drawn from the call's own input and needs no store, no
  // worker and no project — every chat, a code project's included, can
  // show one (mockup-tools.ts).
  tools.push(...mockupTools());
  // A file of the chat's own, or one its project holds.
  const hasFiles =
    (await getDataStore().artifacts.listByChat(context.chatId)).length > 0 ||
    (context.projectId !== null &&
      (await getDataStore().artifacts.listForProject(context.projectId)).length > 0);
  if (hasFiles) {
    tools.push(...attachmentTools());
    // Searching across them, keeping one for the project, sharing one
    // (artifact-tools.ts) — the same acts the Artifacts pages offer.
    tools.push(...artifactTools({ inProject: context.projectId !== null }));
  }
  // A summary and keywords for a file of this chat that got none as it
  // was written: offered wherever a file can be here, now or by the end
  // of the turn.
  if (hasFiles || filesAllowed) tools.push(artifactDescribeTool());
  if (filesAllowed) {
    // The two doors between the chat's files and the sandbox
    // (sandbox-file-tools.ts): offered whenever the chat has the sandbox
    // and the deployment runs one, whether or not the chat has files yet —
    // a picture drawn or a document written THIS turn is a file to stage.
    const sandbox = toolConfig.connectors.includes('sandbox') && sandboxConfig() !== null;
    // Where scripts run, chat_write_file says where a richer document comes from.
    const python = sandbox && (await sandboxScriptsServed().catch(() => false));
    tools.push(...fileTools({ python }));
    if (sandbox) tools.push(...sandboxFileTools());
    // A picture comes from an image generation model, never a chat one;
    // without one in the org the tool is simply not offered. A failed
    // lookup costs the turn this one tool, not the turn.
    const [imageModels, imagePrefs] = await Promise.all([
      listImageModels().catch(() => []),
      getImagePrefs(context.subject),
    ]);
    const imageTool = imageGenerationTool({
      models: imageModels,
      preferredModelId: imagePrefs.modelId,
    });
    if (imageTool) tools.push(imageTool);
    // A chart needs the worker's Chromium as well as somewhere to keep the file.
    if (await sandboxChartsEnabled()) tools.push(...chartTools());
  }
  if (context.projectId) {
    if (!context.readOnly) tools.push(...memoryTools());
  } else if (!context.readOnly) {
    tools.push(...userMemoryTools());
  }
  // Recall sees the project's own chats in a project, the person's own
  // outside one — the tool decides from the context (recall-tools.ts).
  tools.push(...recallTools());
  // The preview cards' state (widget-state-tools.ts): listing is always
  // answerable ("no cards"), and marking one decided writes only the
  // chat's own decision row — the tool refuses under read-only itself.
  tools.push(...widgetStateTools());
  return tools;
}
