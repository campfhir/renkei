'use client';

/**
 * The thread: header, messages, composer — and the stream that keeps it
 * moving. State is the reducer in lib/chat/stream-events.ts fed by one
 * EventSource per running turn; the browser handles reconnects (and
 * resends Last-Event-ID) itself, and we close the source ourselves the
 * moment a turn_end arrives because a server-closed EventSource would
 * otherwise reconnect forever.
 *
 * A new chat (`initialChat === null`) has no address until the first
 * Send creates it; the page then moves to `/chat/{id}` and this component
 * remounts with the real thread (the page keys it by chat id).
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import {
  applyStreamEvent,
  initialThreadState,
  type ChatStreamEvent,
} from '@/lib/chat/stream-events';
import type { AttachmentView, ChatMessageView, ChatView, ModelOption } from '@/lib/chat/views';
import { useChatShell } from './chat-shell';
import Composer, { type ComposerSubmit } from './composer';
import MessageList from './message-list';
import ModelSelect from './model-select';
import ToolsPopover from './tools-popover';
import ShareModal from './share-modal';

interface ThreadProps {
  slug: string;
  tenantId: string;
  subject: string;
  initialChat: ChatView | null;
  initialMessages: ChatMessageView[];
  models: ModelOption[];
  newChatProject: { id: string; name: string } | null;
}

function parseEvent(data: string): ChatStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      // The server built this from the same union; a malformed frame is
      // dropped by the reducer's exhaustive switch returning state as-is.
      return JSON.parse(data);
    }
  } catch {
    // Ignored: the next frame or the safety-net snapshot corrects the view.
  }
  return null;
}

export default function ChatThread({
  slug,
  tenantId,
  initialChat,
  initialMessages,
  models,
  newChatProject,
}: ThreadProps) {
  const router = useRouter();
  const { openSidebar } = useChatShell();
  const [chat, setChat] = useState<ChatView | null>(initialChat);
  const [state, dispatch] = useReducer(
    applyStreamEvent,
    initialThreadState(initialMessages, initialChat?.activeTurn ?? null)
  );
  const [activeTurnId, setActiveTurnId] = useState<string | null>(
    initialChat?.activeTurn?.status === 'running' ? initialChat.activeTurn.id : null
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [modelId, setModelId] = useState<string | null>(
    initialChat?.llmModelId ?? models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null
  );
  const [thinking, setThinking] = useState(initialChat?.thinkingEnabled ?? false);
  const [connectors, setConnectors] = useState<string[] | null>(
    initialChat?.toolConfig?.connectors ?? null
  );
  const isOwner = chat === null || chat.role === 'owner';
  const running = activeTurnId !== null;
  const lastPrompt = useRef<ComposerSubmit | null>(null);

  // One EventSource per running turn.
  useEffect(() => {
    if (!chat || !activeTurnId) return;
    const source = new EventSource(chatClient.streamUrl(tenantId, chat.id, activeTurnId));
    source.addEventListener('turn', (event: MessageEvent<string>) => {
      const parsed = parseEvent(event.data);
      if (!parsed) return;
      dispatch(parsed);
      if (parsed.type === 'turn_end') {
        source.close();
        setActiveTurnId(null);
        // The sidebar's title and ordering come from the server.
        router.refresh();
      }
    });
    source.onerror = () => {
      // The browser retries on its own; nothing to do but wait.
    };
    return () => source.close();
  }, [tenantId, chat, activeTurnId, router]);

  const ensureChat = useCallback(async (): Promise<ChatView | null> => {
    if (chat) return chat;
    const created = await chatClient.createChat(tenantId, {
      projectId: newChatProject?.id ?? null,
      llmModelId: modelId,
      thinkingEnabled: thinking,
    });
    if (created.error || !created.data) {
      setError(created.error ?? 'The chat could not be created.');
      return null;
    }
    const loaded = await chatClient.getChat(tenantId, created.data.chatId);
    if (loaded.error || !loaded.data) {
      setError(loaded.error ?? 'The chat could not be loaded.');
      return null;
    }
    setChat(loaded.data.chat);
    return loaded.data.chat;
  }, [chat, tenantId, newChatProject, modelId, thinking]);

  const submit = useCallback(
    async (input: ComposerSubmit): Promise<boolean> => {
      setError(null);
      setSending(true);
      const target = await ensureChat();
      if (!target) {
        setSending(false);
        return false;
      }
      const started = await chatClient.sendTurn(tenantId, target.id, {
        text: input.text,
        attachmentIds: input.attachments.map((attachment) => attachment.id),
        llmModelId: modelId,
      });
      setSending(false);
      if (started.error || !started.data) {
        setError(started.error ?? 'The message could not be sent.');
        return false;
      }
      lastPrompt.current = input;
      // Optimistic prompt row: the stream only carries the reply.
      dispatch({
        type: 'snapshot',
        turn: {
          id: started.data.turnId,
          status: 'running',
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
        messages: [
          {
            id: started.data.userMessageId,
            turnId: started.data.turnId,
            seq: (state.messages[state.messages.length - 1]?.seq ?? 0) + 1,
            role: 'user',
            kind: 'prompt',
            status: 'complete',
            blocks: input.text ? [{ type: 'text', text: input.text }] : [],
            llmModelId: null,
            provider: null,
            model: null,
            stopReason: null,
            usage: null,
            error: null,
            createdAt: new Date().toISOString(),
            attachments: input.attachments,
          },
        ],
      });
      setActiveTurnId(started.data.turnId);
      if (!chat) router.replace(`/${slug}/chat/${target.id}`);
      return true;
    },
    [ensureChat, tenantId, modelId, state.messages, chat, router, slug]
  );

  const stop = useCallback(async () => {
    if (!chat || !activeTurnId) return;
    await chatClient.cancelTurn(tenantId, chat.id, activeTurnId);
  }, [chat, activeTurnId, tenantId]);

  const changeModel = useCallback(
    async (id: string) => {
      setModelId(id);
      if (chat) await chatClient.updateChat(tenantId, chat.id, { llmModelId: id });
    },
    [chat, tenantId]
  );
  const changeThinking = useCallback(
    async (on: boolean) => {
      setThinking(on);
      if (chat) await chatClient.updateChat(tenantId, chat.id, { thinkingEnabled: on });
    },
    [chat, tenantId]
  );
  const changeConnectors = useCallback(
    async (next: string[] | null) => {
      setConnectors(next);
      if (chat) {
        await chatClient.updateChat(tenantId, chat.id, {
          toolConfig: next ? { connectors: next } : null,
        });
      }
    },
    [chat, tenantId]
  );

  const currentModel = models.find((model) => model.id === modelId) ?? null;
  const title = chat?.title ?? (newChatProject ? `New chat in ${newChatProject.name}` : 'New chat');
  const lastTurn = state.turn;
  const canRetry =
    isOwner &&
    !running &&
    lastPrompt.current !== null &&
    (lastTurn?.status === 'failed' || lastTurn?.status === 'interrupted');

  return (
    <>
      <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open chat list"
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 lg:hidden dark:hover:bg-gray-900"
        >
          <Icon path={ICONS.menu} className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {chat?.projectName ? (
            <p className="truncate text-xs text-gray-500">
              in project{' '}
              <a href={`/${slug}/chat/projects/${chat.projectId}`} className="hover:underline">
                {chat.projectName}
              </a>
            </p>
          ) : null}
        </div>
        {isOwner ? (
          <>
            <ToolsPopover tenantId={tenantId} selected={connectors} onChange={changeConnectors} />
            {chat ? (
              <button
                type="button"
                onClick={() => setShare(true)}
                aria-label="Share chat"
                title="Share"
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.share} className="h-5 w-5" />
              </button>
            ) : null}
          </>
        ) : null}
      </header>

      {chat && !isOwner ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          Shared by {chat.ownerName ?? 'its owner'} — you can read this chat and watch it live. Only
          the owner can continue it.
        </div>
      ) : null}

      <MessageList
        tenantId={tenantId}
        messages={state.messages}
        pendingToolCalls={state.pendingToolCalls}
        running={running}
        turn={state.turn}
        empty={
          chat === null && state.messages.length === 0 ? (
            <EmptyState hasModel={currentModel !== null} />
          ) : null
        }
      />

      {canRetry ? (
        <div className="px-4 pb-1">
          <button
            type="button"
            onClick={() => lastPrompt.current && void submit(lastPrompt.current)}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Retry
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="px-4 pb-1 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {isOwner ? (
        <Composer
          tenantId={tenantId}
          chatId={chat?.id ?? null}
          ensureChatId={async () => (await ensureChat())?.id ?? null}
          disabled={sending || models.length === 0}
          running={running}
          onSubmit={submit}
          onStop={stop}
          modelControl={
            <ModelSelect
              models={models}
              value={modelId}
              onChange={changeModel}
              thinking={thinking}
              onThinking={changeThinking}
              hasHistory={state.messages.length > 0}
            />
          }
        />
      ) : null}
      {share && chat ? (
        <ShareModal
          tenantId={tenantId}
          kind="chat"
          resourceId={chat.id}
          title={`Share “${chat.title ?? 'New chat'}”`}
          onClose={() => setShare(false)}
        />
      ) : null}
    </>
  );
}

function EmptyState({ hasModel }: { hasModel: boolean }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-gray-500">
      {hasModel ? (
        <>
          <p className="text-base font-medium text-gray-700 dark:text-gray-300">
            What are you working on?
          </p>
          <p className="mt-2">
            Ask about tickets, mail, documents or meetings. The assistant uses your own access to
            the organization's tools, and can read files you attach.
          </p>
        </>
      ) : (
        <p>
          No model is configured for this organization yet. An administrator can add one under Agent
          models.
        </p>
      )}
    </div>
  );
}

export type { AttachmentView };
