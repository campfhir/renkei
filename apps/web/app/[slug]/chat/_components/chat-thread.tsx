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
 *
 * In a code project's chat the page also holds the **code pane**
 * (code/_components/code-pane.tsx): beside the chat, about 70% of the
 * main column with a drag handle between and the ratio remembered, when
 * the column is wide enough; under the title bar as the Code tab of a
 * Chat | Code switch when it is not. Both are decided by the column's
 * measured width, never the window's, so a laptop with the app menu open
 * gets the tabs too. The pane's state lives here (use-code-pane.ts) so it
 * survives the move between the two.
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
import type { WidgetModelContextOutcome } from '@/lib/chat/widget-tools';
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
import SubagentModal from './subagent-modal';
import { useMediaQuery } from '@/lib/use-media-query';
import { useElementWidth } from '@/lib/use-element-width';
import { sendJsonFull } from '@/lib/fetch-json';
import type { ChatNote } from '@/lib/code/note-text';
import CodePane from '../../code/_components/code-pane';
import { useCodePane } from '../../code/_components/use-code-pane';

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

/** Under this much main column the code pane becomes the Code tab. */
const SPLIT_MIN_PX = 1024;
/** The chat pane keeps its compact title bar under this width. */
const COMPACT_MAX_PX = 640;
const PANE_OPEN_KEY = 'code-pane:open';
const PANE_RATIO_KEY = 'code-pane:ratio';
const DEFAULT_RATIO = 0.7;
const CHAT_MIN_PX = 320;
const CODE_MIN_PX = 360;

function readRatio(): number {
  try {
    const raw = Number(localStorage.getItem(PANE_RATIO_KEY));
    return Number.isFinite(raw) && raw > 0.2 && raw < 0.9 ? raw : DEFAULT_RATIO;
  } catch {
    return DEFAULT_RATIO;
  }
}

/** The files the chat's own tools wrote in this thread, for the commit dialog's tags. */
function chatWrittenPaths(messages: ChatMessageView[]): Set<string> {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'code_write_file' && block.name !== 'code_edit_file') continue;
      const input: unknown = block.input;
      if (typeof input === 'object' && input !== null && 'path' in input) {
        const path: unknown = input.path;
        if (typeof path === 'string' && path) paths.add(path.replace(/^\.?\/+/, ''));
      }
    }
  }
  return paths;
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
  const [manageDialog, setManageDialog] = useState<'rename' | 'delete' | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [manageBusy, setManageBusy] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
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
  // A code project's chat that is no longer its active one is history:
  // read by anyone, continued by no one (lib/code/active-chat.ts). The
  // composer and the code pane's edits give way to a note saying so.
  const history = chat.projectKind === 'code' && chat.projectActiveChatId !== chat.id;

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
      detectLanguage: true,
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
  // The language the person was last heard speaking, when detection is
  // on: replies are read in it, in a voice that can, so a turn in Japanese
  // after one in English is answered aloud in Japanese. It stands until
  // the next utterance, or until the Language preference is changed.
  const [heardLocale, setHeardLocale] = useState<string | null>(null);
  useEffect(() => {
    setHeardLocale(null);
  }, [voicePrefs.locale, voicePrefs.detectLanguage]);
  const spokenLocale =
    (voicePrefs.detectLanguage ? heardLocale : null) ?? voicePrefs.locale ?? voiceDefaultLocale;
  useEffect(() => {
    if (!speechQueue || !spokenLocale) return;
    speechQueue.configure({
      voice: voicePrefs.voice,
      rate: voicePrefs.rate,
      locale: spokenLocale,
    });
  }, [speechQueue, spokenLocale, voicePrefs.voice, voicePrefs.rate]);
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
  // folds the rest into an overflow menu, so the chat's name stays
  // readable — measured on the chat's own column once it is there, since
  // beside the code pane the column is far narrower than the window.
  const mediaCompact = !useMediaQuery('(min-width: 640px)', true);
  const frameRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const frameWidth = useElementWidth(frameRef);
  const chatWidth = useElementWidth(chatColumnRef);
  const compact = chatWidth !== null ? chatWidth < COMPACT_MAX_PX : mediaCompact;
  const touch = useMediaQuery('(pointer: coarse)');
  const lastPrompt = useRef<ComposerSubmit | null>(null);
  // The code pane's layout: beside the chat, or the Code tab.
  const codeProjectId = chat.projectKind === 'code' && chat.projectId ? chat.projectId : null;
  const paneMode: 'split' | 'tabs' =
    frameWidth !== null && frameWidth < SPLIT_MIN_PX ? 'tabs' : 'split';
  const [paneOpen, setPaneOpen] = useState(true);
  const [paneTab, setPaneTab] = useState<'chat' | 'code'>('chat');
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  useEffect(() => {
    if (!codeProjectId) return;
    try {
      setPaneOpen(localStorage.getItem(PANE_OPEN_KEY) !== 'closed');
    } catch {
      // Left open.
    }
    setRatio(readRatio());
  }, [codeProjectId]);
  const togglePane = useCallback(() => {
    setPaneOpen((open) => {
      try {
        localStorage.setItem(PANE_OPEN_KEY, open ? 'closed' : 'open');
      } catch {
        // Not remembered, then.
      }
      return !open;
    });
  }, []);
  const paneVisible =
    codeProjectId !== null && (paneMode === 'split' ? paneOpen : paneTab === 'code');
  // Bumped when a turn ends: the checkout changed, so the pane reads again.
  const [checkoutVersion, setCheckoutVersion] = useState(0);
  // What the person did from the pane, for the transcript — held while a
  // turn runs (the runner is the only writer then) and sent when it ends.
  const pendingNotes = useRef<ChatNote[]>([]);
  const runningRef = useRef(false);
  const postNote = useCallback(
    async (note: ChatNote) => {
      if (!codeProjectId) return;
      if (runningRef.current) {
        pendingNotes.current.push(note);
        return;
      }
      const result = await sendJsonFull<{ message: ChatMessageView }>(
        `/api/tenant/${tenantId}/chat/chats/${chat.id}/notes`,
        'POST',
        { note }
      );
      if (result.data?.message) dispatch({ type: 'row', message: result.data.message });
      else if (result.status === 409) pendingNotes.current.push(note);
    },
    [codeProjectId, tenantId, chat.id]
  );
  const pane = useCodePane({
    tenantId,
    projectId: codeProjectId,
    chatId: chat.id,
    enabled: paneVisible,
    refreshKey: checkoutVersion,
    onNote: (note) => void postNote(note),
  });
  const chatPaths = useMemo(() => chatWrittenPaths(state.messages), [state.messages]);
  const openPaneFile = pane.open;
  const openInPane = useCallback(
    (path: string) => {
      openPaneFile(path);
      if (paneMode === 'tabs') setPaneTab('code');
      else if (!paneOpen) togglePane();
    },
    [openPaneFile, paneMode, paneOpen, togglePane]
  );

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
        setCheckoutVersion((version) => version + 1);
        // The sidebar's title and ordering come from the server.
        router.refresh();
      }
    });
    source.onerror = () => {
      // The browser retries on its own; nothing to do but wait.
    };
    return () => source.close();
  }, [tenantId, chat, activeTurnId, router]);

  useEffect(() => {
    runningRef.current = running;
    if (running || pendingNotes.current.length === 0) return;
    const held = pendingNotes.current;
    pendingNotes.current = [];
    // Several saves of one file while a turn ran are one note.
    const edited = new Set<string>();
    const notes: ChatNote[] = [];
    for (const note of held) {
      if (note.type === 'edit') note.paths.forEach((path) => edited.add(path));
      else notes.push(note);
    }
    if (edited.size > 0) notes.unshift({ type: 'edit', paths: [...edited] });
    void (async () => {
      for (const note of notes) await postNote(note);
    })();
  }, [running, postNote]);

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
   * A preview card's decision landed (widget-card.tsx): the note row goes
   * in the thread where the person's message would, and when the server
   * opened a turn on it, that turn streams like any reply — the same
   * snapshot-then-listen as begin(), with the server's own row in place
   * of an optimistic one. With no turn (no usable model), the note alone.
   */
  const beginWidgetTurn = useCallback((outcome: WidgetModelContextOutcome) => {
    if (!outcome.turn) {
      dispatch({ type: 'row', message: outcome.message });
      return;
    }
    dispatch({
      type: 'snapshot',
      turn: {
        id: outcome.turn.turnId,
        status: 'running',
        kind: 'reply',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      messages: [outcome.message],
    });
    setActiveTurnId(outcome.turn.turnId);
  }, []);

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
  // A reply still being read aloud counts as running for the queue: a
  // turn that starts while the voice is mid-sentence would silence it
  // (use-reply-speech.ts begins a fresh stream), and a person who spoke
  // over a reply still being worked out asked for their words to wait,
  // not to cut the answer short.
  const readingReply = speech.owner === LIVE_REPLY_OWNER && speech.state !== 'idle';
  useEffect(() => {
    if (running || queue.length === 0) return;
    // Asked of the queue itself, not of the state mirrored from it: the
    // reply's reading begins in an effect of this same commit
    // (useReplySpeech, declared above), one render before the mirror
    // knows — and the turn's end and its last words arrive together.
    // `readingReply` is in the dependencies so the reading's end runs
    // this again.
    if (speechQueue && speechQueue.owner === LIVE_REPLY_OWNER && speechQueue.state !== 'idle') {
      return;
    }
    const [next, ...rest] = queue;
    setQueue(rest);
    if (next.kind === 'compact') void forceCompact();
    else void submit(next.input);
  }, [running, readingReply, speechQueue, queue, submit, forceCompact]);
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

  const runManage = useCallback(async (action: () => Promise<{ error: string | null }>) => {
    setManageBusy(true);
    setManageError(null);
    const result = await action();
    setManageBusy(false);
    if (result.error) {
      setManageError(result.error);
      return;
    }
    setManageDialog(null);
  }, []);

  const toggleArchive = useCallback(() => {
    void runManage(async () => {
      const next = !chat.archived;
      const result = await chatClient.updateChat(tenantId, chat.id, { archived: next });
      if (!result.error) {
        setChat((current) => ({ ...current, archived: next }));
        router.refresh();
      }
      return result;
    });
  }, [chat.archived, chat.id, tenantId, router, runManage]);

  const deleteChat = useCallback(() => {
    void runManage(async () => {
      const result = await chatClient.deleteChat(tenantId, chat.id);
      if (!result.error) router.push(`/${slug}/chat`);
      return result;
    });
  }, [chat.id, tenantId, slug, router, runManage]);

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
  const codeTools = useCodeChatTools({
    tenantId,
    projectId: codeProjectId,
    canEdit: isOwner && !history,
    running,
    messages: state.messages,
    onAsk:
      isOwner && !history && !running && !sending
        ? (text) => submit({ text, attachments: [] })
        : null,
  });
  // A new chat in the project: through the API, which says why when a
  // code project's active chat is still replying; outside one, the page
  // that creates it.
  const startNewChat = useCallback(async () => {
    if (!chat.projectId) {
      router.push(`/${slug}/chat/new`);
      return;
    }
    setError(null);
    const created = await chatClient.createChat(tenantId, { projectId: chat.projectId });
    if (created.error || !created.data) {
      setError(created.error ?? 'A new chat could not be started.');
      return;
    }
    router.push(`/${slug}/chat/${created.data.chatId}`);
  }, [chat.projectId, router, slug, tenantId]);
  const openCommit = codeTools.openChanges;
  const codeActions = useMemo(
    () =>
      codeProjectId
        ? {
            onShowCommit: (sha: string) => openCommit(sha),
            onOpenFile: openInPane,
          }
        : null,
    [codeProjectId, openCommit, openInPane]
  );
  // A sub-agent's transcript, open from its card — in any chat, since any
  // chat may delegate (code_delegate over a checkout, chat_delegate over
  // the chat's reading tools).
  const [subagent, setSubagent] = useState<string | null>(null);
  // The branch under the title: the page's word until the first look at
  // the checkout, then whatever the last look said.
  const branch = codeProjectId ? (codeTools.branch ?? chat.projectBranch) : null;
  const overflow: OverflowItem[] = [
    { label: 'New chat', icon: ICONS.plus, onSelect: () => void startNewChat() },
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
  if (isOwner) {
    overflow.push({ label: 'Share', icon: ICONS.share, onSelect: () => setShare(true) });
    overflow.push({
      label: 'Rename',
      icon: ICONS.pencil,
      onSelect: () => {
        setRenameDraft(chat.title ?? '');
        setManageError(null);
        setManageDialog('rename');
      },
    });
    overflow.push({
      label: chat.archived ? 'Unarchive' : 'Archive',
      icon: ICONS.archive,
      onSelect: toggleArchive,
    });
    overflow.push({
      label: 'Delete',
      icon: ICONS.trash,
      danger: true,
      onSelect: () => {
        setManageError(null);
        setManageDialog('delete');
      },
    });
  }
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
  // The handle between the panes: drag to resize, the ratio kept per browser.
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const frame = frameRef.current;
      if (!frame) return;
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      let next = ratio;
      const move = (moveEvent: PointerEvent) => {
        const min = CODE_MIN_PX / rect.width;
        const max = 1 - CHAT_MIN_PX / rect.width;
        next = Math.min(max, Math.max(min, (moveEvent.clientX - rect.left) / rect.width));
        setRatio(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        try {
          localStorage.setItem(PANE_RATIO_KEY, String(next));
        } catch {
          // Not remembered, then.
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [ratio]
  );
  const codePane = codeProjectId ? (
    <CodePane
      tenantId={tenantId}
      projectId={codeProjectId}
      pane={pane}
      layout={paneMode === 'tabs' ? 'tab' : 'split'}
      touch={touch}
      canEdit={isOwner}
      chatPaths={chatPaths}
      personName={null}
      refreshKey={checkoutVersion}
      backHref={paneMode === 'split' ? backHref : null}
      onNote={(note) => void postNote(note)}
      onAsk={isOwner && !running && !sending ? (text) => submit({ text, attachments: [] }) : null}
      onClose={togglePane}
    />
  ) : null;
  const canRetry =
    isOwner &&
    !running &&
    lastPrompt.current !== null &&
    (lastTurn?.status === 'failed' || lastTurn?.status === 'interrupted');

  return (
    <div ref={frameRef} className="flex h-full min-h-0 min-w-0">
      {codePane && paneMode === 'split' && paneOpen ? (
        <>
          <div
            style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
            className="flex min-w-0 shrink-0 flex-col"
          >
            {codePane}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the code pane"
            onPointerDown={startResize}
            className="w-1 shrink-0 cursor-col-resize border-r border-gray-200 hover:bg-blue-400 dark:border-gray-800 dark:hover:bg-blue-600"
          />
        </>
      ) : null}
      <div ref={chatColumnRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
          {backHref && !(codePane && paneMode === 'split' && paneOpen) ? (
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
            tag={history ? 'history' : null}
            canRename={isOwner}
            onRename={rename}
          />
          {codePane ? (
            paneMode === 'tabs' ? (
              <div
                role="tablist"
                aria-label="Chat or code"
                className="flex shrink-0 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
              >
                {(['chat', 'code'] as const).map((which) => (
                  <button
                    key={which}
                    type="button"
                    role="tab"
                    aria-selected={paneTab === which}
                    aria-label={which === 'chat' ? 'Chat' : 'Code'}
                    onClick={() => setPaneTab(which)}
                    className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${
                      paneTab === which
                        ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-950 dark:text-gray-100'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    <Icon
                      path={which === 'chat' ? ICONS.chat : ICONS.code}
                      className="h-3.5 w-3.5"
                    />
                    {!compact ? <span>{which === 'chat' ? 'Chat' : 'Code'}</span> : null}
                    {which === 'code' && pane.dirtyPaths.length > 0 ? (
                      <span
                        className="rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 text-white"
                        title={`${pane.dirtyPaths.length} file${pane.dirtyPaths.length === 1 ? '' : 's'} with unsaved edits`}
                      >
                        {pane.dirtyPaths.length}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={togglePane}
                aria-pressed={paneOpen}
                aria-label={paneOpen ? 'Hide the code' : 'Show the code'}
                title={
                  paneOpen
                    ? 'Hide the repository’s files'
                    : 'Show the repository’s files beside the chat'
                }
                className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${
                  paneOpen
                    ? 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
                }`}
              >
                <Icon path={ICONS.code} className="h-4 w-4" />
                {!compact ? <span>Code</span> : null}
              </button>
            )
          ) : null}
          <ArtifactsMenu tenantId={tenantId} artifacts={state.artifacts} />
          {compact ? (
            isOwner ? (
              <ToolsPopover
                tenantId={tenantId}
                selected={connectors}
                onChange={changeConnectors}
                slug={slug}
                locked={codeProjectId ? CODE_PROJECT_CONNECTORS : undefined}
                kind={codeProjectId ? 'code' : 'chat'}
              />
            ) : null
          ) : (
            <>
              {codeProjectId ? <CodeChatButtons tools={codeTools} canEdit={isOwner} /> : null}
              {isOwner ? (
                <ToolsPopover
                  tenantId={tenantId}
                  selected={connectors}
                  onChange={changeConnectors}
                  slug={slug}
                  locked={codeProjectId ? CODE_PROJECT_CONNECTORS : undefined}
                  kind={codeProjectId ? 'code' : 'chat'}
                />
              ) : null}
            </>
          )}
          <OverflowMenu items={overflow} />
        </header>
        {codeTools.modals}
        {subagent ? (
          <SubagentModal
            tenantId={tenantId}
            chatId={chat.id}
            toolUseId={subagent}
            onClose={() => setSubagent(null)}
          />
        ) : null}

        {codePane && paneMode === 'tabs' && paneTab === 'code' ? (
          <div className="flex min-h-0 flex-1 flex-col">{codePane}</div>
        ) : (
          <>
            {!isOwner ? (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                Shared by {chat.ownerName ?? 'its owner'} — you can read this chat and watch it
                live. Only the owner can continue it.
              </div>
            ) : null}

            <MessageList
              tenantId={tenantId}
              chatId={chat.id}
              messages={state.messages}
              pendingToolCalls={state.pendingToolCalls}
              running={running}
              turn={state.turn}
              compaction={state.compaction}
              promptActions={
                isOwner && !history && !running && !sending
                  ? { onResend: setConfirmResend, onEdit: setEditing }
                  : null
              }
              permission={
                state.pendingPermission && running
                  ? {
                      pending: state.pendingPermission,
                      canDecide: isOwner,
                      onDecide: decidePermission,
                    }
                  : null
              }
              code={codeActions}
              subagents={state.subagents}
              onShowSubagent={setSubagent}
              onWidgetDecision={isOwner ? beginWidgetTurn : null}
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
              empty={
                state.messages.length === 0 ? <EmptyState hasModel={currentModel !== null} /> : null
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

            {history ? (
              <div
                data-testid="chat-history-notice"
                className="border-t border-gray-200 px-4 py-3 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400"
              >
                <p>
                  <span className="font-medium text-gray-800 dark:text-gray-200">
                    This chat is history.
                  </span>{' '}
                  {chat.projectActiveChatId
                    ? 'The project has moved on to a newer chat; this one stays to read.'
                    : 'The project has no active chat right now; this one stays to read.'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {chat.projectActiveChatId ? (
                    <Link
                      href={`/${slug}/chat/${chat.projectActiveChatId}`}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Open the active chat
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void startNewChat()}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                  >
                    Start a new chat
                  </button>
                </div>
              </div>
            ) : isOwner ? (
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
                        detectLanguage: voicePrefs.detectLanguage,
                        onHeard: setHeardLocale,
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
          </>
        )}
      </div>
      {voiceMode && voice && speechQueue ? (
        <VoiceMode
          tenantId={tenantId}
          locale={voicePrefs.locale ?? voice.defaultLocale}
          detectLanguage={voicePrefs.detectLanguage}
          onHeard={setHeardLocale}
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
          queued={queue.length}
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
      {manageDialog === 'rename' ? (
        <Modal title="Rename chat" onClose={() => setManageDialog(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runManage(async () => {
                const next = renameDraft.trim();
                if (!next) return { error: 'The name can’t be empty.' };
                const saved = await rename(next);
                return { error: saved ? null : 'The chat could not be renamed.' };
              });
            }}
            className="space-y-3"
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={200}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <DialogFooter
              busy={manageBusy}
              error={manageError}
              label="Rename"
              onCancel={() => setManageDialog(null)}
            />
          </form>
        </Modal>
      ) : null}
      {manageDialog === 'delete' ? (
        <Modal title="Delete chat" onClose={() => setManageDialog(null)}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            This deletes the chat, its messages and its files for everyone it was shared with.
          </p>
          <DialogFooter
            busy={manageBusy}
            error={manageError}
            label="Delete"
            danger
            onCancel={() => setManageDialog(null)}
            onConfirm={deleteChat}
          />
        </Modal>
      ) : null}
    </div>
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
