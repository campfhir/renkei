'use client';

/**
 * The thread: header, messages, composer — and the stream that keeps it
 * moving. State is the reducer in lib/chat/stream-events.ts fed by one
 * EventSource per running turn; the browser handles reconnects (and
 * resends Last-Event-ID) itself, and we close the source ourselves the
 * moment a turn_end arrives because a server-closed EventSource would
 * otherwise reconnect forever.
 *
 * A chat exists before this mounts — "+ New" creates an empty one and
 * lands on its address — so the first Send is a turn like any other: no
 * address change, no reload, nothing lost mid-reply.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import { CODE_PROJECT_CONNECTORS } from '@/lib/chat/tool-config';
import {
  applyStreamEvent,
  initialThreadState,
  type ChatStreamEvent,
} from '@/lib/chat/stream-events';
import type {
  AttachmentView,
  ChatMessageView,
  ChatView,
  ModelOption,
  ToolPermissionDecision,
} from '@/lib/chat/views';
import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceAvailability } from '@/lib/voice/availability';
import { voiceClient } from '@/lib/voice/client';
import { SpeechQueue, type SpeechQueueState } from '@/lib/voice/speech-queue';
import { takeSpeakable } from '@/lib/voice/sentences';
import { LIVE_REPLY_OWNER, replyProse, useReplySpeech } from '@/lib/voice/use-reply-speech';
import {
  getAudioOutput,
  getEchoCancellation,
  getMicrophone,
  setAudioOutput,
  setEchoCancellation,
  setMicrophone,
} from '@/lib/voice/device-settings';
import Modal from '@/components/modal';
import ArtifactsMenu from './artifacts-menu';
import ChatTitle from './chat-title';
import { DialogFooter } from './chat-nav';
import Composer, { type ComposerSubmit } from './composer';
import MessageList from './message-list';
import ModelSelect from './model-select';
import ToolsPopover from './tools-popover';
import ShareModal from './share-modal';
import {
  ChangesBadge,
  CodeChatButtons,
  useCodeChatTools,
} from '../../code/_components/code-chat-tools';
import AutoModeToggle from './auto-mode-toggle';
import OverflowMenu, { type OverflowItem } from './overflow-menu';
import VoiceMenu from './voice-menu';
import VoiceMode, { type VoiceActivity } from './voice-mode';
import { useMediaQuery } from '@/lib/use-media-query';

interface ThreadProps {
  slug: string;
  tenantId: string;
  subject: string;
  initialChat: ChatView;
  initialMessages: ChatMessageView[];
  models: ModelOption[];
  /** The org has file storage; without it the composer offers no uploads. */
  uploadsEnabled: boolean;
  /** The org has a voice service, and how this person has it set; null shows nothing about voice. */
  voice: VoiceAvailability | null;
}

/** A code project's page lives under Code; a chat project's under Chat. */
function projectHref(slug: string, projectId: string, kind: 'chat' | 'code' | null): string {
  return kind === 'code' ? `/${slug}/code/${projectId}` : `/${slug}/chat/projects/${projectId}`;
}

/** The typed text of a prompt row, without the attachment excerpts the model saw. */
function promptTextOf(message: ChatMessageView): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/<attachment [^>]*>[\s\S]*?<\/attachment>/g, '')
    .trim();
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
  uploadsEnabled,
  voice,
}: ThreadProps) {
  const router = useRouter();
  const [chat, setChat] = useState<ChatView>(initialChat);
  const [state, dispatch] = useReducer(
    applyStreamEvent,
    initialThreadState(initialMessages, initialChat.activeTurn, initialChat.artifacts)
  );
  const [activeTurnId, setActiveTurnId] = useState<string | null>(
    initialChat.activeTurn?.status === 'running' ? initialChat.activeTurn.id : null
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [editing, setEditing] = useState<ChatMessageView | null>(null);
  const [confirmResend, setConfirmResend] = useState<ChatMessageView | null>(null);
  const [modelId, setModelId] = useState<string | null>(
    initialChat.llmModelId ?? models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null
  );
  const [thinking, setThinking] = useState(initialChat.thinkingEnabled);
  const [autoMode, setAutoMode] = useState(initialChat.autoMode);
  const [connectors, setConnectors] = useState<string[] | null>(
    initialChat.toolConfig?.connectors ?? null
  );
  const isOwner = chat.role === 'owner';
  const running = activeTurnId !== null;

  /*
    Voice, when the org has it: one speech queue for the thread (a reply
    being read live, or a Listen button's), this person's preferences,
    and whether the immersive voice conversation is open. With `voice`
    null none of this renders and none of it runs.
  */
  const [voicePrefs, setVoicePrefs] = useState<VoicePrefs>(
    voice?.prefs ?? {
      voice: null,
      rate: 1,
      autoPlay: false,
      locale: null,
      pushToTalk: false,
      accent: 'rainbow',
      userAccent: 'emerald',
    }
  );
  const [voiceMode, setVoiceMode] = useState(false);
  // This device's echo-cancellation choice: read once mounted (there is
  // no storage on the server), written the moment it is changed.
  const [echoCancellation, setEchoCancellationState] = useState(true);
  useEffect(() => {
    setEchoCancellationState(getEchoCancellation(tenantId));
  }, [tenantId]);
  const changeEchoCancellation = useCallback(
    (on: boolean) => {
      setEchoCancellationState(on);
      setEchoCancellation(tenantId, on);
    },
    [tenantId]
  );
  // Likewise this device's microphone and speaker, where the browser
  // lets a page choose; null is the system default.
  const [microphone, setMicrophoneState] = useState<string | null>(null);
  const [audioOutput, setAudioOutputState] = useState<string | null>(null);
  useEffect(() => {
    setMicrophoneState(getMicrophone(tenantId));
    setAudioOutputState(getAudioOutput(tenantId));
  }, [tenantId]);
  const changeMicrophone = useCallback(
    (deviceId: string | null) => {
      setMicrophoneState(deviceId);
      setMicrophone(tenantId, deviceId);
    },
    [tenantId]
  );
  const changeAudioOutput = useCallback(
    (deviceId: string | null) => {
      setAudioOutputState(deviceId);
      setAudioOutput(tenantId, deviceId);
    },
    [tenantId]
  );
  const [speechQueue, setSpeechQueue] = useState<SpeechQueue | null>(null);
  const [speech, setSpeech] = useState<{ state: SpeechQueueState; owner: string | null }>({
    state: 'idle',
    owner: null,
  });
  // Keyed on whether voice exists, never on the prop object: every
  // turn_end refreshes the page's server data, which hands this a new
  // `voice` object, and a queue rebuilt on that would fall silent in the
  // middle of the reply it was reading.
  const voiceAvailable = voice !== null;
  const voiceDefaultLocale = voice?.defaultLocale ?? null;
  useEffect(() => {
    if (!voiceAvailable) return;
    const created = new SpeechQueue(tenantId, (message) => setError(message));
    const unsubscribe = created.subscribe((state) => setSpeech({ state, owner: created.owner }));
    setSpeechQueue(created);
    return () => {
      unsubscribe();
      created.dispose();
      setSpeechQueue(null);
    };
  }, [tenantId, voiceAvailable]);
  useEffect(() => {
    speechQueue?.setOutputDevice(audioOutput);
  }, [speechQueue, audioOutput]);
  useEffect(() => {
    if (!speechQueue || !voiceDefaultLocale) return;
    speechQueue.configure({
      voice: voicePrefs.voice,
      rate: voicePrefs.rate,
      locale: voicePrefs.locale ?? voiceDefaultLocale,
    });
  }, [speechQueue, voiceDefaultLocale, voicePrefs]);
  useReplySpeech({
    queue: speechQueue,
    enabled: voice !== null && (voicePrefs.autoPlay || voiceMode),
    messages: state.messages,
    activeTurnId,
  });
  const changeVoicePrefs = useCallback(
    (next: VoicePrefs) => {
      setVoicePrefs(next);
      void voiceClient.savePrefs(tenantId, next);
    },
    [tenantId]
  );
  /** Read one earlier reply aloud, in pieces so the first is heard at once. */
  const listen = useCallback(
    (key: string, markdown: string) => {
      if (!speechQueue) return;
      speechQueue.prime();
      speechQueue.begin(key);
      for (const chunk of takeSpeakable(markdown, { final: true }).chunks) {
        speechQueue.enqueue(chunk);
      }
      speechQueue.finish();
    },
    [speechQueue]
  );
  const stopReading = useCallback(() => speechQueue?.stop(), [speechQueue]);
  const pauseReading = useCallback(() => speechQueue?.pause(), [speechQueue]);
  const resumeReading = useCallback(() => speechQueue?.resume(), [speechQueue]);
  // Below `sm` the title bar keeps only Tools as a button of its own and
  // folds the rest into an overflow menu, so the chat's name stays readable.
  const compact = !useMediaQuery('(min-width: 640px)', true);
  const lastPrompt = useRef<ComposerSubmit | null>(null);

  // One EventSource per running turn.
  useEffect(() => {
    if (!activeTurnId) return;
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

  /** The optimistic prompt row and the turn to follow: the stream only carries the reply. */
  const begin = useCallback(
    (started: { turnId: string; userMessageId: string }, input: ComposerSubmit, seq: number) => {
      dispatch({
        type: 'snapshot',
        turn: {
          id: started.turnId,
          status: 'running',
          kind: 'reply',
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
        messages: [
          {
            id: started.userMessageId,
            turnId: started.turnId,
            seq,
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
      setActiveTurnId(started.turnId);
    },
    []
  );

  /**
   * Force a compaction pass: /compact, or "Compact this conversation" from
   * the prompt picker. Rides the same turn machinery as a reply (an
   * optimistic compaction_progress event stands in for begin()'s
   * optimistic prompt row — there is no message of its own to show yet).
   */
  const forceCompact = useCallback(async (): Promise<boolean> => {
    setError(null);
    const started = await chatClient.compact(tenantId, chat.id);
    if (started.error || !started.data) {
      setError(started.error ?? 'Compaction could not be started.');
      return false;
    }
    dispatch({
      type: 'compaction_progress',
      turnId: started.data.turnId,
      foldedSoFar: 0,
      totalToFold: 0,
    });
    setActiveTurnId(started.data.turnId);
    return true;
  }, [chat.id, tenantId]);

  const submit = useCallback(
    async (input: ComposerSubmit): Promise<boolean> => {
      // A slash command, not a message — /compact runs the same fold a
      // person could ask the model for in plain language, directly rather
      // than waiting on the model to decide to call the tool.
      if (input.text.trim().toLowerCase() === '/compact') return forceCompact();
      setError(null);
      setSending(true);
      const started = await chatClient.sendTurn(tenantId, chat.id, {
        text: input.text,
        attachmentIds: input.attachments.map((attachment) => attachment.id),
        llmModelId: modelId,
        ...(input.voice ? { voice: true } : {}),
      });
      setSending(false);
      if (started.error || !started.data) {
        setError(started.error ?? 'The message could not be sent.');
        return false;
      }
      lastPrompt.current = input;
      begin(started.data, input, (state.messages[state.messages.length - 1]?.seq ?? 0) + 1);
      return true;
    },
    [forceCompact, tenantId, modelId, state.messages, chat.id, begin]
  );

  /**
   * While a turn is running — a reply OR a compaction pass, `running`
   * covers both — a new Send queues instead of being rejected, and the
   * moment `running` goes false this effect drains the next one on its
   * own: nobody has to click anything for a queued message to go out.
   * Each item keeps its own id so the composer can list them and let the
   * person remove any one, not just clear the whole queue.
   */
  type QueuedItem =
    { id: number; kind: 'message'; input: ComposerSubmit } | { id: number; kind: 'compact' };
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const nextQueueId = useRef(0);
  const queueOrSend = useCallback(
    (input: ComposerSubmit): Promise<boolean> => {
      if (!running) return submit(input);
      nextQueueId.current += 1;
      setQueue((current) => [...current, { id: nextQueueId.current, kind: 'message', input }]);
      return Promise.resolve(true);
    },
    [running, submit]
  );
  const queueOrCompact = useCallback((): Promise<boolean> => {
    if (!running) return forceCompact();
    nextQueueId.current += 1;
    setQueue((current) => [...current, { id: nextQueueId.current, kind: 'compact' }]);
    return Promise.resolve(true);
  }, [running, forceCompact]);
  const removeQueued = useCallback((id: number) => {
    setQueue((current) => current.filter((item) => item.id !== id));
  }, []);
  useEffect(() => {
    if (running || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    if (next.kind === 'compact') void forceCompact();
    else void submit(next.input);
  }, [running, queue, submit, forceCompact]);
  const queueView = queue.map((item) => ({
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

  /**
   * Resend a prompt as it was, or with the text now in the box: the server
   * removes that row and everything after it, then starts a turn; the
   * page drops the same rows and follows the new turn as after Send.
   */
  const resend = useCallback(
    async (message: ChatMessageView, input: ComposerSubmit | null): Promise<boolean> => {
      setError(null);
      setSending(true);
      const resent = await chatClient.resend(tenantId, chat.id, message.id, {
        text: input ? input.text : null,
        attachmentIds: input ? input.attachments.map((attachment) => attachment.id) : [],
        llmModelId: modelId,
      });
      setSending(false);
      if (resent.error || !resent.data) {
        setError(resent.error ?? 'The message could not be resent.');
        return false;
      }
      const prompt: ComposerSubmit = {
        text: input ? input.text : promptTextOf(message),
        attachments: [...message.attachments, ...(input?.attachments ?? [])],
      };
      lastPrompt.current = prompt;
      setEditing(null);
      dispatch({
        type: 'truncate',
        fromSeq: resent.data.fromSeq,
        removedArtifactIds: resent.data.removedArtifactIds,
      });
      begin(resent.data, prompt, resent.data.fromSeq);
      return true;
    },
    [chat.id, tenantId, modelId, begin]
  );

  const onComposerSubmit = useCallback(
    (input: ComposerSubmit) => (editing ? resend(editing, input) : queueOrSend(input)),
    [editing, resend, queueOrSend]
  );

  const rename = useCallback(
    async (next: string): Promise<string | null> => {
      const result = await chatClient.updateChat(tenantId, chat.id, { title: next });
      if (result.error) {
        setError(result.error);
        return null;
      }
      setChat((current) => ({ ...current, title: next }));
      // The menu's list carries the name too.
      router.refresh();
      return next;
    },
    [chat.id, tenantId, router]
  );

  /**
   * Answer the tool call the turn is waiting on. Returns the error to show,
   * or null: the stream's tool_permission_decided event clears the card.
   */
  const decidePermission = useCallback(
    async (toolUseId: string, decision: ToolPermissionDecision): Promise<string | null> => {
      if (!activeTurnId) return 'The reply is no longer running.';
      const result = await chatClient.decideToolPermission(
        tenantId,
        chat.id,
        activeTurnId,
        toolUseId,
        decision
      );
      if (result.error) {
        // Answered elsewhere already (another tab, a timeout): the next
        // stream event or snapshot removes the card on its own.
        if (result.status === 409) {
          dispatch({ type: 'tool_permission_decided', turnId: activeTurnId, toolUseId, decision });
          return null;
        }
        return result.error;
      }
      return null;
    },
    [activeTurnId, chat.id, tenantId]
  );

  const stop = useCallback(async () => {
    // Stopping the reply stops the reading of it too.
    speechQueue?.stop();
    if (!activeTurnId) return;
    await chatClient.cancelTurn(tenantId, chat.id, activeTurnId);
  }, [chat.id, activeTurnId, tenantId, speechQueue]);

  const changeModel = useCallback(
    async (id: string) => {
      setModelId(id);
      await chatClient.updateChat(tenantId, chat.id, { llmModelId: id });
    },
    [chat.id, tenantId]
  );
  const changeThinking = useCallback(
    async (on: boolean) => {
      setThinking(on);
      await chatClient.updateChat(tenantId, chat.id, { thinkingEnabled: on });
    },
    [chat.id, tenantId]
  );
  // Auto mode (lib/chat/auto-mode.ts): kept on the chat row, read by the
  // next Send; a switch flipped mid-turn does not change the running one.
  const changeAutoMode = useCallback(
    async (on: boolean) => {
      setAutoMode(on);
      await chatClient.updateChat(tenantId, chat.id, { autoMode: on });
    },
    [chat.id, tenantId]
  );
  const changeConnectors = useCallback(
    async (next: string[] | null) => {
      setConnectors(next);
      await chatClient.updateChat(tenantId, chat.id, {
        toolConfig: next ? { connectors: next } : null,
      });
    },
    [chat.id, tenantId]
  );

  const currentModel = models.find((model) => model.id === modelId) ?? null;
  // Untitled until its first reply names it; a project's says which.
  const title = chat.title ?? (chat.projectName ? `New chat in ${chat.projectName}` : 'New chat');
  // A chat in a project has a way back to it.
  const backHref =
    chat.projectId && chat.projectName ? projectHref(slug, chat.projectId, chat.projectKind) : null;
  // A chat in a code project: its checkout's changes and environment are
  // a button away in the title bar.
  const codeProjectId = chat.projectKind === 'code' && chat.projectId ? chat.projectId : null;
  const codeTools = useCodeChatTools({
    tenantId,
    chatId: chat.id,
    projectId: codeProjectId,
    canEdit: isOwner,
    running,
    messages: state.messages,
    onAsk: isOwner && !running && !sending ? (text) => submit({ text, attachments: [] }) : null,
  });
  const openCommit = codeTools.openChanges;
  const openSubagent = codeTools.openSubagent;
  const codeActions = useMemo(
    () =>
      codeProjectId
        ? { onShowCommit: (sha: string) => openCommit(sha), onShowSubagent: openSubagent }
        : null,
    [codeProjectId, openCommit, openSubagent]
  );
  // The branch under the title: the page's word until the first look at
  // the checkout, then whatever the last look said.
  const branch = codeProjectId ? (codeTools.branch ?? chat.projectBranch) : null;
  const overflow: OverflowItem[] = [
    {
      label: 'New chat',
      icon: ICONS.plus,
      onSelect: () =>
        router.push(`/${slug}/chat/new${chat.projectId ? `?project=${chat.projectId}` : ''}`),
    },
  ];
  if (codeProjectId) {
    overflow.push({ label: 'Environment', icon: ICONS.chip, onSelect: codeTools.openEnvironment });
    if (isOwner)
      overflow.push({ label: 'Add files', icon: ICONS.upload, onSelect: codeTools.openFiles });
    overflow.push({
      label: 'Changes',
      icon: ICONS.diff,
      onSelect: () => codeTools.openChanges(),
      extra:
        (codeTools.stat && codeTools.stat.files > 0) || codeTools.commits.length > 0 ? (
          <ChangesBadge tools={codeTools} />
        ) : undefined,
    });
  }
  if (isOwner) overflow.push({ label: 'Share', icon: ICONS.share, onSelect: () => setShare(true) });
  const lastTurn = state.turn;
  // For voice mode: the tool calls in flight by name, and whether the
  // model is mid-thought with nothing said yet. Read off the messages,
  // not the turn view: a turn started from this page has no view until a
  // snapshot arrives, and the calls are in flight before then.
  const voiceActivity = useMemo((): VoiceActivity[] => {
    if (state.pendingToolCalls.length === 0) return [];
    // Each call with what the model said just before it, if anything: a
    // voice turn is asked to introduce its calls, and the page announces
    // only the ones it did not.
    const calls = new Map<string, { name: string; said: string | null }>();
    for (const message of state.messages) {
      let said: string | null = null;
      for (const block of message.blocks) {
        if (block.type === 'text' && block.text.trim()) said = block.text.trim();
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, said });
      }
    }
    return state.pendingToolCalls.map((id) => ({
      id,
      name: calls.get(id)?.name ?? 'tool',
      said: calls.get(id)?.said ?? null,
    }));
  }, [state.messages, state.pendingToolCalls]);
  const voiceThinking = useMemo(() => {
    if (!running) return false;
    const streaming = [...state.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.status === 'streaming');
    const last = streaming?.blocks[streaming.blocks.length - 1];
    return last?.type === 'thinking' || last?.type === 'redacted_thinking';
  }, [running, state.messages]);
  const canRetry =
    isOwner &&
    !running &&
    lastPrompt.current !== null &&
    (lastTurn?.status === 'failed' || lastTurn?.status === 'interrupted');

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        {backHref ? (
          <Link
            href={backHref}
            aria-label="Back to project"
            title="Back to the project"
            className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.chevronLeft} className="h-5 w-5" />
          </Link>
        ) : null}
        <ChatTitle
          title={title}
          project={
            chat.projectId && chat.projectName
              ? {
                  id: chat.projectId,
                  name: chat.projectName,
                  href: projectHref(slug, chat.projectId, chat.projectKind),
                  branch,
                }
              : null
          }
          canRename={isOwner}
          onRename={rename}
        />
        <ArtifactsMenu tenantId={tenantId} artifacts={state.artifacts} />
        {compact ? (
          <>
            {isOwner ? (
              <ToolsPopover
                tenantId={tenantId}
                selected={connectors}
                onChange={changeConnectors}
                slug={slug}
                locked={codeProjectId ? CODE_PROJECT_CONNECTORS : undefined}
                context={codeProjectId ? 'code' : 'chat'}
              />
            ) : null}
            <OverflowMenu items={overflow} />
          </>
        ) : (
          <>
            {codeProjectId ? <CodeChatButtons tools={codeTools} canEdit={isOwner} /> : null}
            {isOwner ? (
              <>
                <ToolsPopover
                  tenantId={tenantId}
                  selected={connectors}
                  onChange={changeConnectors}
                  slug={slug}
                  locked={codeProjectId ? CODE_PROJECT_CONNECTORS : undefined}
                  context={codeProjectId ? 'code' : 'chat'}
                />
                <button
                  type="button"
                  onClick={() => setShare(true)}
                  aria-label="Share chat"
                  title="Share"
                  className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.share} className="h-4 w-4" />
                  <span>Share</span>
                </button>
              </>
            ) : null}
          </>
        )}
      </header>
      {codeTools.modals}

      {!isOwner ? (
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
        compaction={state.compaction}
        promptActions={
          isOwner && !running && !sending
            ? { onResend: setConfirmResend, onEdit: setEditing }
            : null
        }
        permission={
          state.pendingPermission && running
            ? { pending: state.pendingPermission, canDecide: isOwner, onDecide: decidePermission }
            : null
        }
        code={codeActions}
        subagents={state.subagents}
        speech={
          voice && speechQueue
            ? {
                playingKey: speech.state === 'idle' ? null : speech.owner,
                paused: speech.state === 'paused',
                onListen: listen,
                onPause: pauseReading,
                onResume: resumeReading,
                onStop: stopReading,
              }
            : null
        }
        empty={state.messages.length === 0 ? <EmptyState hasModel={currentModel !== null} /> : null}
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
          chatId={chat.id}
          disabled={sending || models.length === 0}
          running={running}
          queue={queueView}
          onRemoveQueued={removeQueued}
          onClearQueue={() => setQueue([])}
          uploads={uploadsEnabled}
          onSubmit={onComposerSubmit}
          onCompact={queueOrCompact}
          editing={editing ? { text: promptTextOf(editing) } : null}
          onCancelEdit={() => setEditing(null)}
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
          modeControl={
            codeProjectId ? (
              <AutoModeToggle
                on={autoMode}
                onChange={changeAutoMode}
                disabled={models.length === 0}
              />
            ) : null
          }
          dictation={
            voice
              ? {
                  tenantId,
                  locale: voicePrefs.locale ?? voice.defaultLocale,
                  accent: voicePrefs.userAccent,
                  echoCancellation,
                  microphone,
                }
              : null
          }
          voiceControl={
            voice && speechQueue ? (
              <VoiceMenu
                tenantId={tenantId}
                prefs={voicePrefs}
                defaults={{ voice: voice.defaultVoice, locale: voice.defaultLocale }}
                queueState={speech.state}
                levels={speechQueue}
                echoCancellation={echoCancellation}
                onEchoCancellation={changeEchoCancellation}
                microphone={microphone}
                onMicrophone={changeMicrophone}
                audioOutput={audioOutput}
                onAudioOutput={changeAudioOutput}
                onChange={changeVoicePrefs}
                onStopReading={stopReading}
                onStartVoiceMode={() => setVoiceMode(true)}
                onPrime={() => speechQueue.prime()}
                disabled={models.length === 0}
              />
            ) : null
          }
        />
      ) : null}
      {voiceMode && voice && speechQueue ? (
        <VoiceMode
          tenantId={tenantId}
          locale={voicePrefs.locale ?? voice.defaultLocale}
          queue={speechQueue}
          queueState={speech.owner === LIVE_REPLY_OWNER ? speech.state : 'idle'}
          running={running}
          accent={voicePrefs.accent}
          userAccent={voicePrefs.userAccent}
          echoCancellation={echoCancellation}
          microphone={microphone}
          pushToTalk={voicePrefs.pushToTalk}
          replyText={lastTurn ? replyProse(state.messages, lastTurn.id) : ''}
          activity={voiceActivity}
          thinking={voiceThinking}
          permission={
            state.pendingPermission && running
              ? { pending: state.pendingPermission, canDecide: isOwner, onDecide: decidePermission }
              : null
          }
          onSend={(text) => queueOrSend({ text, attachments: [], voice: true })}
          onInterrupt={() => void stop()}
          onClose={() => setVoiceMode(false)}
        />
      ) : null}
      {confirmResend ? (
        <Modal title="Resend this message?" onClose={() => setConfirmResend(null)}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            The message is sent again as it was. Every reply after it, and any files those replies
            produced, are removed.
          </p>
          <DialogFooter
            busy={sending}
            error={null}
            label="Resend"
            onCancel={() => setConfirmResend(null)}
            onConfirm={() => {
              const message = confirmResend;
              setConfirmResend(null);
              void resend(message, null);
            }}
          />
        </Modal>
      ) : null}
      {share ? (
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
