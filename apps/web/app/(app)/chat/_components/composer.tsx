'use client';

/**
 * Where the person writes: an auto-growing textarea (Enter sends,
 * Shift+Enter breaks a line; on a touch screen the button sends), files
 * dropped or picked are uploaded at once and shown as chips until Send
 * attaches them to the message, and the model/thinking control sits in
 * the same row. A prompt-library picker opens from the sparkle button or
 * by typing "/" into an empty box.
 *
 * What it decides — where chosen files go, chips or one counter, what the
 * send slot holds, what Send does with files still being placed — is
 * composer.model.ts, tested in composer.model.test.ts; this component makes
 * the calls and draws.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import Modal from '@/components/modal';
import { chatClient } from '@/lib/chat/client';
import type { AttachmentView } from '@/lib/chat/views';
import { UtteranceRecorder } from '@/lib/voice/recorder';
import { LevelEmitter } from '@/lib/voice/levels';
import { voiceClient } from '@/lib/voice/client';
import AttachmentListModal from './attachment-list-modal';
import AttachmentChip from './attachment-chip';
import ComposerToolsMenu from './composer-tools-menu';
import PromptPicker from './prompt-picker';
import { usePathCompletions, type PathCompletionScope } from './path-autocomplete';
import { VoiceWaveIcon, type WaveAccent } from './voice-wave';
import { useDraftSync } from './use-draft-sync';
import {
  UPLOAD_CONCURRENCY,
  batchWarning,
  composerReducer,
  dropQuestion,
  filesChosen,
  initialComposer,
  needsOcr,
  ocrBatches,
  placeholder,
  proceedWith,
  queueRow,
  readyToSendAfterUpload,
  rememberedLabel,
  sendButton,
  sendStep,
  stagingRow,
  type ComposerAction,
  type ComposerSubmit,
  type DropDestination,
  type QueuedComposerItem,
} from './composer.model';

/**
 * Dictation, when the org has a voice service: a microphone beside the
 * box that turns what the person says into text IN the box — to read
 * over, fix and send like anything typed. The lighter way to talk to the
 * chat; the immersive conversation is a click away for anyone who wants
 * the big buttons and the voice read back.
 */
export interface DictationSetup {
  /** The language to recognise — or, when detecting, the one to fall back to. */
  locale: string;
  /** Hear which language each utterance is in, rather than assume `locale`. */
  detectLanguage: boolean;
  /** The language an utterance was heard in, so a reply read aloud is spoken in it. */
  onHeard: (locale: string) => void;
  /** The person's own wave colour — the bars while they dictate. */
  accent: WaveAccent;
  /** This device's echo-cancellation choice (lib/voice/device-settings.ts). */
  echoCancellation: boolean;
  /** This device's chosen microphone, or null for the default. */
  microphone: string | null;
}

export type { ComposerSubmit, QueuedComposerItem };

const MAX_ROWS = 10;

const DROP_CHOICE_KEY = (projectId: string) => `renkei.artifact-drop.${projectId}`;

/** The destination this browser remembers for the project, or null when it was never chosen. */
function rememberedDropChoice(projectId: string): DropDestination | null {
  try {
    const stored = window.localStorage.getItem(DROP_CHOICE_KEY(projectId));
    return stored === 'project' || stored === 'message' ? stored : null;
  } catch {
    return null;
  }
}

function forgetDropChoice(projectId: string): void {
  try {
    window.localStorage.removeItem(DROP_CHOICE_KEY(projectId));
  } catch {
    // Nothing stored, nothing to forget.
  }
}

function rememberDropChoice(projectId: string, choice: DropDestination): void {
  try {
    window.localStorage.setItem(DROP_CHOICE_KEY(projectId), choice);
  } catch {
    // Private windows and blocked storage: the question is simply asked again.
  }
}

export default function Composer({
  chatId,
  disabled,
  running,
  queue,
  onRemoveQueued,
  onClearQueue,
  uploads,
  massUploadThreshold,
  onSubmit,
  onCompact,
  onStop,
  modelControl,
  modeControl,
  voiceControl,
  voicePanel,
  onVoiceOpen,
  dictation,
  editing,
  onCancelEdit,
  project = null,
  bare = false,
  draft,
  pathCompletions = null,
}: {
  chatId: string;
  disabled: boolean;
  running: boolean;
  /** Sends waiting for the current turn to finish, oldest first — auto-sent one at a time, no click needed. */
  queue: QueuedComposerItem[];
  onRemoveQueued: (id: number) => void;
  onClearQueue: () => void;
  /** Files can be attached at all — false when the org has no storage. */
  uploads: boolean;
  /** More files than this in a chat is a mass upload: confirm first, OCR scans afterwards. */
  massUploadThreshold: number;
  /** While running, this queues instead of sending — the caller decides which. */
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  /** Forces a compaction pass — /compact, or picked from the prompt picker. */
  onCompact: () => Promise<boolean>;
  onStop: () => Promise<void>;
  modelControl: ReactNode;
  /** The Auto switch, in a code project's chat (auto-mode-toggle.tsx); nothing elsewhere. */
  modeControl?: ReactNode;
  /** The speaker menu, when the org has a voice service; nothing otherwise. */
  voiceControl?: ReactNode;
  /**
   * The same speaker menu as the tools menu's second level (composer-tools-menu.tsx),
   * which stands in for the prompt, speaker and microphone buttons on a phone in a
   * code project, where the row also holds the Auto switch.
   */
  voicePanel?: (level: { onBack: () => void; onClose: () => void }) => ReactNode;
  onVoiceOpen?: () => void;
  /** The microphone beside the box, when the org has a voice service. */
  dictation?: DictationSetup | null;
  /** An earlier prompt being rewritten: its text fills the box, Send resends it. */
  editing: { text: string } | null;
  onCancelEdit: () => void;
  /**
   * The project the chat is in, when it is in one: a dropped file may then
   * be kept as a project artifact (every chat in the project reads it) or
   * attached to this message only. The choice is remembered per project.
   */
  project?: { id: string; name: string } | null;
  /**
   * No bar of its own: no background, border or padding around the box, for
   * a composer that sits inside a dialog which has its own edges.
   */
  bare?: boolean;
  /**
   * The chat's saved unsent text (drafts.ts): given, the box starts with it
   * and keeps it saved as the person types; left out, the box is not
   * persisted at all (a throwaway composer in a dialog).
   */
  draft?: string;
  /**
   * In a code project's chat: `@` completes a path in the repository
   * (path-autocomplete.tsx). Nothing elsewhere.
   */
  pathCompletions?: PathCompletionScope | null;
}) {
  const [state, dispatch] = useReducer(composerReducer<File>, draft, initialComposer<File>);
  const {
    text,
    attachments,
    uploadError,
    pendingBatch,
    pendingDrop,
    dropChoice,
    rememberDrop,
    remembered,
    listOpen,
    queueOpen,
    dragging,
    prompts,
    dictating,
    hearing,
    dictationError,
  } = state;
  const setText = useCallback((next: string) => dispatch({ type: 'typed', text: next }), []);
  useEffect(() => {
    dispatch({
      type: 'rememberedLoaded',
      choice: project ? rememberedDropChoice(project.id) : null,
    });
  }, [project]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const completions = usePathCompletions({ scope: pathCompletions, textareaRef, text, setText });
  // An earlier prompt being rewritten fills the box but is not a draft of the next one.
  useDraftSync(chatId, text, draft !== undefined && !editing, draft ?? '');
  const composerAnchor = useCoachAnchor('chat-composer');
  const sendAnchor = useCoachAnchor('chat-send');
  const attachAnchor = useCoachAnchor('chat-attach');
  const promptAnchor = useCoachAnchor('chat-prompt');
  const voiceAnchor = useCoachAnchor('chat-voice');
  // A code project's row runs out of room in a narrow column — a phone, or a
  // chat beside the code pane — so the tools fold into one menu below 30rem of
  // the composer's own width (a container query, not the window's).
  const foldTools = Boolean(modeControl) && Boolean(dictation || voicePanel);

  // Dictation: one recorder while the microphone is on; each utterance
  // is transcribed and appended to whatever is in the box.
  const recorder = useRef<UtteranceRecorder | null>(null);
  // The microphone's loudness goes to the bars by subscription, never
  // through state: a render per reading would redraw the whole composer.
  const micLevels = useRef(new LevelEmitter());
  const stopDictation = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
    dispatch({ type: 'dictationStopped' });
    micLevels.current.emit(0);
  }, []);
  const startDictation = useCallback(async () => {
    if (!dictation || recorder.current) return;
    const { locale, detectLanguage, onHeard, echoCancellation, microphone } = dictation;
    const instance = new UtteranceRecorder({
      echoCancellation,
      deviceId: microphone,
      onSpeechStart: () => dispatch({ type: 'speechHeard' }),
      onUtterance: (wav) => {
        void (async () => {
          dispatch({ type: 'utteranceEnded' });
          const result = await voiceClient.transcribe(wav, { locale, detectLanguage });
          if (result.error) {
            dispatch({ type: 'transcriptionFailed', error: result.error });
            return;
          }
          const spoken = result.data?.text.trim() ?? '';
          if (!spoken) return;
          if (result.data?.locale) onHeard(result.data.locale);
          dispatch({ type: 'spoken', text: spoken });
          textareaRef.current?.focus();
        })();
      },
      onLevel: (next) => micLevels.current.emit(next),
      onError: (message) => {
        recorder.current?.stop();
        recorder.current = null;
        dispatch({ type: 'dictationFailed', error: message });
        micLevels.current.emit(0);
      },
    });
    recorder.current = instance;
    dispatch({ type: 'dictationStarted' });
    const ok = await instance.start();
    if (!ok) stopDictation();
  }, [dictation, stopDictation]);
  useEffect(() => () => recorder.current?.stop(), []);

  // Editing starts with the old text in the box and the cursor at its end.
  useEffect(() => {
    if (!editing) return;
    dispatch({ type: 'editStarted', text: editing.text });
    const element = textareaRef.current;
    if (element) {
      element.focus();
      element.setSelectionRange(editing.text.length, editing.text.length);
    }
  }, [editing]);
  useEffect(() => {
    dispatch({ type: 'queueLengthChanged', length: queue.length });
  }, [queue.length]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const grow = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const line = 24;
    element.style.height = `${Math.min(element.scrollHeight, line * MAX_ROWS + 16)}px`;
  }, []);
  useEffect(grow, [text, grow]);

  /** Files are OCR'd in the background; the send button waits on `uploading` only. */
  const runOcr = useCallback(
    async (ids: string[]) => {
      dispatch({ type: 'ocrStarted', count: ids.length });
      for (const batch of ocrBatches(ids)) {
        const results = await chatClient.ocrAttachments(chatId, batch);
        dispatch({ type: 'ocrAnswered', count: batch.length, results });
      }
    },
    [chatId]
  );

  /** Upload files the model has already counted in (`uploadStarted` or `batchConfirmed`). */
  const runUpload = useCallback(
    async (list: File[], keep: boolean) => {
      const stored: AttachmentView[] = [];
      let next = 0;
      const lane = async () => {
        while (next < list.length) {
          const file = list[next++];
          // Kept: an artifact of the person's, attached to the project as well
          // as sent with this message (artifact-routes.ts).
          const result =
            keep && project
              ? await chatClient.uploadArtifact({ chatId, keep: true, projectId: project.id }, file)
              : await chatClient.uploadAttachment({ chatId }, file);
          const attachment = result.data;
          if (result.error || !attachment) {
            dispatch({ type: 'fileFailed', filename: file.name, error: result.error ?? null });
            continue;
          }
          stored.push(attachment);
          dispatch({ type: 'fileUploaded', attachment });
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, list.length) }, lane));
      dispatch({ type: 'uploadSettled', count: list.length });
      const ids = needsOcr(stored);
      if (ids.length > 0) void runOcr(ids);
    },
    [chatId, project, runOcr]
  );

  /** Dispatch where the files go, and start them uploading when that is at once. */
  const place = useCallback(
    (action: ComposerAction<File> | null) => {
      if (!action) return;
      dispatch(action);
      if (action.type === 'uploadStarted') void runUpload(action.files, action.keep);
    },
    [runUpload]
  );

  const upload = useCallback(
    (files: FileList | File[]) => {
      // In a project, where a file goes is the person's call, made once
      // per project and remembered in this browser until they change it.
      place(
        filesChosen(state, [...files], {
          inProject: Boolean(project),
          remembered: project ? rememberedDropChoice(project.id) : null,
          threshold: massUploadThreshold,
        })
      );
    },
    [state, project, massUploadThreshold, place]
  );

  const confirmDrop = useCallback(() => {
    const list = pendingDrop;
    if (!list) return;
    if (project && rememberDrop) rememberDropChoice(project.id, dropChoice);
    dispatch({ type: 'dropConfirmed', inProject: Boolean(project) });
    place(proceedWith(state, list, dropChoice === 'project', massUploadThreshold));
  }, [pendingDrop, project, rememberDrop, dropChoice, state, massUploadThreshold, place]);

  const forgetDrop = useCallback(() => {
    if (!project) return;
    forgetDropChoice(project.id);
    dispatch({ type: 'dropForgotten' });
  }, [project]);

  const confirmBatch = useCallback(() => {
    const list = pendingBatch;
    if (!list) return;
    const keep = state.keepChoice;
    dispatch({ type: 'batchConfirmed' });
    void runUpload(list, keep);
  }, [pendingBatch, state.keepChoice, runUpload]);

  const staging = stagingRow(state);

  const remove = useCallback(async (attachment: AttachmentView) => {
    dispatch({ type: 'attachmentRemoved', id: attachment.id });
    await chatClient.deleteAttachment(attachment.id);
  }, []);

  const send = useCallback(async () => {
    const step = sendStep(state, disabled);
    // Files still waiting for the person to say where they go: Send is
    // the answer — the choice as it stands is taken, the files upload,
    // and the message goes out once they are up.
    if (step.kind === 'placeThenSend') {
      dispatch({ type: 'sendQueuedBehindUploads' });
      confirmDrop();
      return;
    }
    // Sending while running is not blocked here — the caller (onSubmit)
    // queues it and returns true.
    if (step.kind !== 'submit') return;
    const ok = await onSubmit(step.input);
    if (ok) dispatch({ type: 'submitted' });
  }, [state, disabled, onSubmit, confirmDrop]);

  const sendAfterUpload = readyToSendAfterUpload(state);
  useEffect(() => {
    // The send waits for the files: the chooser's answer taken, a mass
    // upload's own warning answered, every upload finished. Cancelling the
    // warning drops the pending send and leaves the message in the box.
    if (!sendAfterUpload) return;
    dispatch({ type: 'sendAfterUploadTaken' });
    void send();
  }, [sendAfterUpload, send]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The path list has first claim on arrows, Enter, Tab and Escape while it shows.
    if (completions.onKeyDown(event)) return;
    if (event.key === '/' && text === '') {
      event.preventDefault();
      dispatch({ type: 'promptsOpened' });
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      // Touch keyboards have no Shift+Enter; there, Enter breaks a line
      // and the button sends.
      if (window.matchMedia('(pointer: coarse)').matches) return;
      event.preventDefault();
      void send();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dispatch({ type: 'dragEnded' });
    if (uploads && event.dataTransfer.files?.length) upload(event.dataTransfer.files);
  };

  const slot = sendButton(state, { running, disabled });

  return (
    <div
      className={`@container shrink-0 ${
        bare
          ? ''
          : 'border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-900/60'
      }`}
    >
      {editing ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <Icon path={ICONS.pencil} className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Editing an earlier message. Sending it replaces every reply after it.
          </span>
          <button
            type="button"
            onClick={() => {
              dispatch({ type: 'editCancelled' });
              onCancelEdit();
            }}
            className="rounded px-1.5 py-0.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {queueRow(queue.length) === 'inline' ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          <Icon path={ICONS.clock} className="h-3.5 w-3.5 shrink-0" />
          <Icon
            path={queue[0].isCompact ? ICONS.package : ICONS.chat}
            className="h-3.5 w-3.5 shrink-0 text-gray-400"
          />
          <span className="flex-1 truncate">{queue[0].label}</span>
          <span className="shrink-0 text-gray-400">queued</span>
          <button
            type="button"
            onClick={() => onRemoveQueued(queue[0].id)}
            aria-label={`Remove "${queue[0].label}" from the queue`}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.close} className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : queueRow(queue.length) === 'summary' ? (
        <button
          type="button"
          onClick={() => dispatch({ type: 'queueOpened' })}
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <Icon path={ICONS.clock} className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {queue.length} queued — sent one at a time, automatically, once this finishes.
          </span>
          <span className="shrink-0 font-medium text-blue-600 dark:text-blue-400">View</span>
        </button>
      ) : null}
      {queueOpen ? (
        <Modal title={`Queued (${queue.length})`} onClose={() => dispatch({ type: 'queueClosed' })}>
          <p className="mb-2 text-xs text-gray-500">
            Sent one at a time, automatically, once the current reply finishes — nothing here needs
            a click to go out.
          </p>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {queue.map((item, index) => (
              <li
                key={item.id}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300"
              >
                <span className="w-5 shrink-0 pt-0.5 text-right text-xs text-gray-400">
                  {index + 1}.
                </span>
                <Icon
                  path={item.isCompact ? ICONS.package : ICONS.chat}
                  className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
                />
                {/* Wraps rather than truncating — this is the one place meant
                    for reading a queued item in full — but each item's own
                    height is capped and scrolls on its own, so one very long
                    message can't push the rest of the list (or the modal)
                    out; the list below has its own cap for many items. */}
                <div className="max-h-24 min-w-0 flex-1 overflow-y-auto py-0.5 break-words whitespace-pre-wrap">
                  {item.label}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveQueued(item.id)}
                  aria-label={`Remove "${item.label}" from the queue`}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                >
                  <Icon path={ICONS.close} className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={onClearQueue}
              className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              Clear all
            </button>
          </div>
        </Modal>
      ) : null}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (uploads) dispatch({ type: 'dragOver' });
        }}
        onDragLeave={() => dispatch({ type: 'dragEnded' })}
        onDrop={onDrop}
        {...composerAnchor}
        className={`transition ${
          bare
            ? `border-t py-2 ${
                dragging
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-gray-200 dark:border-gray-800'
              }`
            : `rounded-xl border bg-white dark:bg-gray-900 ${
                dragging
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-gray-300 dark:border-gray-700'
              }`
        }`}
      >
        {pendingDrop && project ? (
          <div
            role="group"
            aria-label="Where should the files go?"
            className="m-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200"
          >
            <p className="mb-1.5 font-medium">{dropQuestion(pendingDrop)}</p>
            <label className="flex cursor-pointer items-start gap-2 py-0.5">
              <input
                type="radio"
                name="drop-destination"
                checked={dropChoice === 'project'}
                onChange={() => dispatch({ type: 'dropChoiceChanged', choice: 'project' })}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Artifacts, attached to {project.name}</span>
                <span className="block text-blue-800/80 dark:text-blue-300/80">
                  Kept for every chat in this project and reusable elsewhere. Sent with this message
                  too.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 py-0.5">
              <input
                type="radio"
                name="drop-destination"
                checked={dropChoice === 'message'}
                onChange={() => dispatch({ type: 'dropChoiceChanged', choice: 'message' })}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">This message only</span>
                <span className="block text-blue-800/80 dark:text-blue-300/80">
                  Readable in this chat; not part of the project.
                </span>
              </span>
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <button
                type="button"
                onClick={confirmDrop}
                className="rounded bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'dropCancelled' })}
                className="rounded px-2 py-1 font-medium hover:bg-blue-100 dark:hover:bg-blue-900/40"
              >
                Cancel
              </button>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={rememberDrop}
                  onChange={(event) =>
                    dispatch({ type: 'rememberDropChanged', on: event.target.checked })
                  }
                />
                Remember for {project.name}
              </label>
              <span className="text-blue-800/80 dark:text-blue-300/80">
                Sending the message adds them too.
              </span>
            </div>
          </div>
        ) : null}
        {pendingBatch ? (
          <div
            role="alertdialog"
            aria-label="Large upload"
            className="m-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <p className="font-medium">{batchWarning(pendingBatch, massUploadThreshold).title}</p>
            <p className="mt-1">{batchWarning(pendingBatch, massUploadThreshold).detail}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={confirmBatch}
                className="rounded-md bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700"
              >
                {batchWarning(pendingBatch, massUploadThreshold).confirm}
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'batchCancelled' })}
                className="rounded-md px-2.5 py-1 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {staging.shown ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {staging.folded ? (
              <button
                type="button"
                onClick={() => dispatch({ type: 'listOpened' })}
                aria-label={`Show all ${attachments.length} attached files`}
                className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Icon path={ICONS.paperclip} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                {staging.counter}
              </button>
            ) : (
              attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => void remove(attachment)}
                />
              ))
            )}
            {staging.uploading ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                {staging.uploading}
              </span>
            ) : null}
            {staging.ocr ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                {staging.ocr}
              </span>
            ) : null}
          </div>
        ) : null}
        {listOpen ? (
          <AttachmentListModal
            attachments={attachments}
            onRemove={(attachment) => void remove(attachment)}
            onClose={() => dispatch({ type: 'listClosed' })}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onSelect={completions.refresh}
          aria-autocomplete={pathCompletions ? 'list' : undefined}
          aria-controls={completions.open ? completions.listboxId : undefined}
          aria-activedescendant={completions.activeId}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (uploads && files.length > 0) {
              event.preventDefault();
              upload(files);
            }
          }}
          placeholder={placeholder(state, running)}
          rows={1}
          disabled={disabled}
          aria-label="Message"
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none disabled:opacity-60"
        />
        {completions.overlay}
        <div className="flex items-center gap-1 px-2 pb-2">
          {project && remembered ? (
            <button
              type="button"
              onClick={forgetDrop}
              aria-label={`Dropped files go to ${rememberedLabel(remembered, project.name).where}. Ask me again next time.`}
              data-tip={`Dropped files go to ${rememberedLabel(remembered, project.name).where}. Click to be asked again next time.`}
              data-tip-start=""
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <Icon path={ICONS.layers} className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">
                {rememberedLabel(remembered, project.name).short}
              </span>
            </button>
          ) : null}
          {uploads ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach a file"
              title="Attach a file"
              {...attachAnchor}
              disabled={disabled}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <Icon path={ICONS.paperclip} className="h-5 w-5" />
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) upload(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => dispatch({ type: 'promptsOpened' })}
            aria-label="Insert a prompt"
            title="Prompt libraries"
            {...promptAnchor}
            disabled={disabled}
            className={`rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 ${
              foldTools ? '@max-[30rem]:hidden' : ''
            }`}
          >
            <Icon path={ICONS.sparkle} className="h-5 w-5" />
          </button>
          {foldTools ? (
            <ComposerToolsMenu
              disabled={disabled}
              dictating={dictating}
              wave={
                dictation ? (
                  <VoiceWaveIcon
                    levels={hearing ? micLevels.current : null}
                    accent={dictation.accent}
                  />
                ) : null
              }
              canDictate={Boolean(dictation)}
              onPrompts={() => dispatch({ type: 'promptsOpened' })}
              onToggleDictation={() => (dictating ? stopDictation() : void startDictation())}
              voicePanel={voicePanel}
              onVoiceOpen={onVoiceOpen}
            />
          ) : null}
          {foldTools ? (
            <div className="contents @max-[30rem]:hidden">{voiceControl}</div>
          ) : (
            voiceControl
          )}
          {dictation ? (
            <button
              type="button"
              onClick={() => (dictating ? stopDictation() : void startDictation())}
              aria-pressed={dictating}
              aria-label={dictating ? 'Stop dictating' : 'Dictate'}
              {...voiceAnchor}
              title={dictating ? 'Stop dictating' : 'Dictate: speak into the box'}
              disabled={disabled}
              className={`flex items-center justify-center rounded-md p-1.5 disabled:opacity-40 ${
                foldTools ? '@max-[30rem]:hidden ' : ''
              }${
                dictating
                  ? 'bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/40'
                  : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {dictating ? (
                <VoiceWaveIcon
                  levels={hearing ? micLevels.current : null}
                  accent={dictation.accent}
                />
              ) : (
                <Icon path={ICONS.microphone} className="h-5 w-5" />
              )}
            </button>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {modelControl}
            {modeControl}
          </div>
          {slot.kind === 'stop' ? (
            // Stop lives in the send button's slot ONLY while there is
            // nothing to send. The moment something is typed, that slot
            // becomes the blue send button again, and pressing it queues.
            // An earlier layout kept Stop in the slot and put a grey queue
            // button beside it: thumbs trained on "the button on the right
            // sends" stopped the reply they meant to queue behind.
            <button
              type="button"
              onClick={() => void onStop()}
              aria-label="Stop"
              className="rounded-md bg-gray-900 p-1.5 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
            >
              <Icon path={ICONS.stop} className="h-5 w-5" />
            </button>
          ) : slot.kind === 'queue' ? (
            <button
              type="button"
              onClick={() => void send()}
              aria-label="Queue this message"
              title="Sends once the current reply finishes"
              disabled={slot.disabled}
              className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <Icon path={ICONS.send} className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              aria-label="Send"
              disabled={slot.disabled}
              className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700 disabled:opacity-40"
              {...sendAnchor}
            >
              <Icon path={ICONS.send} className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
      {uploadError ? (
        <p className={`mt-1 text-xs text-red-600 ${bare ? 'px-3' : ''}`}>{uploadError}</p>
      ) : null}
      {dictationError ? (
        <p className={`mt-1 text-xs text-red-600 ${bare ? 'px-3' : ''}`}>{dictationError}</p>
      ) : null}
      <p className={`mt-1 hidden text-[11px] text-gray-400 sm:block ${bare ? 'px-3 pb-2' : ''}`}>
        Enter to send, Shift+Enter for a new line, / for a prompt.
      </p>
      {prompts ? (
        <PromptPicker
          onClose={() => {
            dispatch({ type: 'promptsClosed' });
            textareaRef.current?.focus();
          }}
          onPick={(body) => {
            dispatch({ type: 'promptPicked', body });
            textareaRef.current?.focus();
          }}
          onCompact={() => {
            dispatch({ type: 'promptsClosed' });
            void onCompact();
          }}
        />
      ) : null}
    </div>
  );
}
