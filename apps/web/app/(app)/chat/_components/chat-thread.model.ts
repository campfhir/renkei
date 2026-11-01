/**
 * The thread's send path (chat-thread.tsx), without the stream: the sends
 * queued behind a running turn (added, removed one at a time, cleared,
 * drained oldest first and only once the model is free), what a turn or a
 * resend asks the server for, editing and resending an earlier prompt, and
 * the rename / delete / branch dialogs.
 *
 * The component makes the calls, holds the stream and the voice, draws the
 * queue ids (a counter the voice ticket needs at once), and dispatches
 * what the person did and what the server answered; tested in
 * chat-thread.model.test.ts.
 */

import type { ChatMessageView, ChatView, ModelOption, QueuedSend } from '@/lib/chat/views';
import type { ComposerSubmit, QueuedComposerItem } from './composer.model';

export type ManageDialog = 'rename' | 'delete' | 'branch';

export interface ThreadSendState {
  /** Sends held for after the running turn, oldest first. */
  queue: QueuedSend[];
  /** An earlier prompt being rewritten in the composer. */
  editing: ChatMessageView | null;
  /** An earlier prompt waiting on "Resend?" being confirmed. */
  confirmResend: ChatMessageView | null;
  dialog: ManageDialog | null;
  renameDraft: string;
  manageBusy: boolean;
  manageError: string | null;
}

export function initialThreadSend(chat: Pick<ChatView, 'queue'>): ThreadSendState {
  return {
    queue: chat.queue,
    editing: null,
    confirmResend: null,
    dialog: null,
    renameDraft: '',
    manageBusy: false,
    manageError: null,
  };
}

/** The highest id among held sends, so the next one drawn is new. */
export function lastQueueId(queue: QueuedSend[]): number {
  return queue.reduce((max, item) => Math.max(max, item.id), 0);
}

export type ThreadSendAction =
  /** A message held behind the running turn; `id` is drawn by the component. */
  | { type: 'messageQueued'; id: number; input: ComposerSubmit }
  | { type: 'compactQueued'; id: number }
  | { type: 'queuedRemoved'; id: number }
  | { type: 'queueCleared' }
  /** The oldest held send went out. */
  | { type: 'queuedSent'; id: number }
  /** The words of a held voice message were heard again in another language. */
  | { type: 'queuedTextCorrected'; id: number; text: string }
  | { type: 'editStarted'; message: ChatMessageView }
  | { type: 'editCancelled' }
  | { type: 'resendAsked'; message: ChatMessageView }
  | { type: 'resendDismissed' }
  /** A resend (edited or as it was) started its turn. */
  | { type: 'resent' }
  | { type: 'renameOpened'; title: string | null }
  | { type: 'deleteOpened' }
  | { type: 'branchOpened' }
  | { type: 'dialogClosed' }
  | { type: 'renameTyped'; text: string }
  | { type: 'manageStarted' }
  | { type: 'manageFailed'; error: string }
  | { type: 'manageDone' };

export function threadSendReducer(
  state: ThreadSendState,
  action: ThreadSendAction
): ThreadSendState {
  switch (action.type) {
    case 'messageQueued':
      return {
        ...state,
        queue: [...state.queue, { id: action.id, kind: 'message', input: action.input }],
      };
    case 'compactQueued':
      return { ...state, queue: [...state.queue, { id: action.id, kind: 'compact' }] };
    case 'queuedRemoved':
    case 'queuedSent':
      return { ...state, queue: state.queue.filter((item) => item.id !== action.id) };
    case 'queueCleared':
      return { ...state, queue: [] };
    case 'queuedTextCorrected':
      return {
        ...state,
        queue: state.queue.map((item) =>
          item.id === action.id && item.kind === 'message'
            ? { ...item, input: { ...item.input, text: action.text } }
            : item
        ),
      };
    case 'editStarted':
      return { ...state, editing: action.message };
    case 'editCancelled':
      return { ...state, editing: null };
    case 'resendAsked':
      return { ...state, confirmResend: action.message };
    case 'resendDismissed':
      return { ...state, confirmResend: null };
    case 'resent':
      return { ...state, editing: null };
    case 'renameOpened':
      return { ...state, dialog: 'rename', renameDraft: action.title ?? '', manageError: null };
    case 'deleteOpened':
      return { ...state, dialog: 'delete', manageError: null };
    case 'branchOpened':
      return { ...state, dialog: 'branch' };
    case 'dialogClosed':
      return { ...state, dialog: null };
    case 'renameTyped':
      return { ...state, renameDraft: action.text };
    case 'manageStarted':
      return { ...state, manageBusy: true, manageError: null };
    case 'manageFailed':
      // The dialog stays open with the reason.
      return { ...state, manageBusy: false, manageError: action.error };
    case 'manageDone':
      return { ...state, manageBusy: false, dialog: null };
  }
}

/**
 * Where a submit from the composer goes: a resend of the prompt being
 * edited; otherwise straight out, or held while a turn (a reply or a
 * compaction pass) runs — a Send then queues instead of being rejected.
 */
export function submitRoute(
  state: Pick<ThreadSendState, 'editing'>,
  running: boolean
): 'resend' | 'send' | 'queue' {
  if (state.editing) return 'resend';
  return running ? 'queue' : 'send';
}

/** "/compact" is a command, not a message: it runs a compaction pass directly. */
export function isCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/compact';
}

/**
 * The held send to go out now, or null. Nothing goes while a turn runs,
 * nor while a reply is still being read aloud — a turn starting mid-
 * sentence would silence it, and words spoken over a reply asked to wait.
 */
export function nextToSend(
  queue: QueuedSend[],
  context: { running: boolean; readingReply: boolean }
): QueuedSend | null {
  if (context.running || context.readingReply) return null;
  return queue[0] ?? null;
}

/** The queue as the composer lists it: what each item will do, in a line. */
export function queueView(queue: QueuedSend[]): QueuedComposerItem[] {
  return queue.map((item) => ({
    id: item.id,
    isCompact: item.kind === 'compact',
    label:
      item.kind === 'compact'
        ? 'Compact this conversation'
        : item.input.text.trim() ||
          (item.input.attachments.length > 0
            ? `${item.input.attachments.length} file${item.input.attachments.length === 1 ? '' : 's'}`
            : 'Message'),
  }));
}

/** What a Send asks the server for (the client adds the browser's time zone). */
export function turnRequest(
  input: ComposerSubmit,
  modelId: string | null
): { text: string; attachmentIds: string[]; llmModelId: string | null; voice?: true } {
  return {
    text: input.text,
    attachmentIds: input.attachments.map((attachment) => attachment.id),
    llmModelId: modelId,
    ...(input.voice ? { voice: true as const } : {}),
  };
}

/** What a resend asks for: the edited text and new files, or (null) the prompt as it was. */
export function resendRequest(
  input: ComposerSubmit | null,
  modelId: string | null
): { text: string | null; attachmentIds: string[]; llmModelId: string | null; voice?: true } {
  return {
    text: input ? input.text : null,
    attachmentIds: input ? input.attachments.map((attachment) => attachment.id) : [],
    llmModelId: modelId,
    ...(input?.voice ? { voice: true as const } : {}),
  };
}

/** The typed text of a prompt row, without the attachment excerpts the model saw. */
export function promptTextOf(message: ChatMessageView): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/<attachment [^>]*>[\s\S]*?<\/attachment>/g, '')
    .trim();
}

/** The prompt row a resend shows: the new text (or the old), the old files and any new ones. */
export function resentPrompt(
  message: ChatMessageView,
  input: ComposerSubmit | null
): ComposerSubmit {
  return {
    text: input ? input.text : promptTextOf(message),
    attachments: [...message.attachments, ...(input?.attachments ?? [])],
  };
}

/** An earlier prompt can be edited or resent only by the owner, with nothing running or sending. */
export function promptActionsOffered(context: {
  isOwner: boolean;
  running: boolean;
  sending: boolean;
}): boolean {
  return context.isOwner && !context.running && !context.sending;
}

/** What Rename saves: the trimmed name, or why not. */
export function renameRequest(draft: string): { title: string } | { error: string } {
  const title = draft.trim();
  return title ? { title } : { error: 'The name can’t be empty.' };
}

/** The model a chat opens on: its own, else the organization's default, else the first, else none. */
export function initialModelId(
  chat: Pick<ChatView, 'llmModelId'>,
  models: Pick<ModelOption, 'id' | 'isDefault'>[]
): string | null {
  return chat.llmModelId ?? models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
}

/** The chat's tool choice as saved: a list of connectors, or null for "the defaults". */
export function connectorsPatch(next: string[] | null): {
  toolConfig: { connectors: string[] } | null;
} {
  return { toolConfig: next ? { connectors: next } : null };
}
