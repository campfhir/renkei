'use client';

/**
 * Where the person writes: an auto-growing textarea (Enter sends,
 * Shift+Enter breaks a line; on a touch screen the button sends), files
 * dropped or picked are uploaded at once and shown as chips until Send
 * attaches them to the message, and the model/thinking control sits in
 * the same row. A prompt-library picker opens from the sparkle button or
 * by typing "/" into an empty box.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon, ICONS } from '@/components/icons';
import Modal from '@/components/modal';
import { chatClient } from '@/lib/chat/client';
import type { AttachmentView } from '@/lib/chat/views';
import { UtteranceRecorder } from '@/lib/voice/recorder';
import { LevelEmitter } from '@/lib/voice/levels';
import { voiceClient } from '@/lib/voice/client';
import AttachmentChip from './attachment-chip';
import PromptPicker from './prompt-picker';
import { VoiceWaveIcon, type WaveAccent } from './voice-wave';

/**
 * Dictation, when the org has a voice service: a microphone beside the
 * box that turns what the person says into text IN the box — to read
 * over, fix and send like anything typed. The lighter way to talk to the
 * chat; the immersive conversation is a click away for anyone who wants
 * the big buttons and the voice read back.
 */
export interface DictationSetup {
  tenantId: string;
  /** The language to recognise. */
  locale: string;
  /** The person's own wave colour — the bars while they dictate. */
  accent: WaveAccent;
  /** This device's echo-cancellation choice (lib/voice/device-settings.ts). */
  echoCancellation: boolean;
}

export interface ComposerSubmit {
  text: string;
  attachments: AttachmentView[];
}

/** One queued send, shown in order with what it will do and how to drop it. */
export interface QueuedComposerItem {
  id: number;
  label: string;
  isCompact: boolean;
}

const MAX_ROWS = 10;

export default function Composer({
  tenantId,
  chatId,
  disabled,
  running,
  queue,
  onRemoveQueued,
  onClearQueue,
  uploads,
  onSubmit,
  onCompact,
  onStop,
  modelControl,
  voiceControl,
  dictation,
  editing,
  onCancelEdit,
}: {
  tenantId: string;
  chatId: string;
  disabled: boolean;
  running: boolean;
  /** Sends waiting for the current turn to finish, oldest first — auto-sent one at a time, no click needed. */
  queue: QueuedComposerItem[];
  onRemoveQueued: (id: number) => void;
  onClearQueue: () => void;
  /** Files can be attached at all — false when the org has no storage. */
  uploads: boolean;
  /** While running, this queues instead of sending — the caller decides which. */
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  /** Forces a compaction pass — /compact, or picked from the prompt picker. */
  onCompact: () => Promise<boolean>;
  onStop: () => Promise<void>;
  modelControl: ReactNode;
  /** The speaker menu, when the org has a voice service; nothing otherwise. */
  voiceControl?: ReactNode;
  /** The microphone beside the box, when the org has a voice service. */
  dictation?: DictationSetup | null;
  /** An earlier prompt being rewritten: its text fills the box, Send resends it. */
  editing: { text: string } | null;
  onCancelEdit: () => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentView[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [prompts, setPrompts] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Dictation: one recorder while the microphone is on; each utterance
  // is transcribed and appended to whatever is in the box.
  const [dictating, setDictating] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const recorder = useRef<UtteranceRecorder | null>(null);
  // The microphone's loudness goes to the bars by subscription, never
  // through state: a render per reading would redraw the whole composer.
  const micLevels = useRef(new LevelEmitter());
  const stopDictation = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
    setDictating(false);
    setHearing(false);
    micLevels.current.emit(0);
  }, []);
  const startDictation = useCallback(async () => {
    if (!dictation || recorder.current) return;
    setDictationError(null);
    const { tenantId: tenant, locale, echoCancellation } = dictation;
    const instance = new UtteranceRecorder({
      echoCancellation,
      onSpeechStart: () => setHearing(true),
      onUtterance: (wav) => {
        void (async () => {
          setHearing(false);
          const result = await voiceClient.transcribe(tenant, wav, locale);
          if (result.error) {
            setDictationError(result.error);
            return;
          }
          const spoken = result.data?.text.trim() ?? '';
          if (!spoken) return;
          setText((current) =>
            current.trim() ? `${current.replace(/\s+$/, '')} ${spoken}` : spoken
          );
          textareaRef.current?.focus();
        })();
      },
      onLevel: (next) => micLevels.current.emit(next),
      onError: (message) => {
        setDictationError(message);
        stopDictation();
      },
    });
    recorder.current = instance;
    setDictating(true);
    const ok = await instance.start();
    if (!ok) stopDictation();
  }, [dictation, stopDictation]);
  useEffect(() => () => recorder.current?.stop(), []);

  // Editing starts with the old text in the box and the cursor at its end.
  useEffect(() => {
    if (!editing) return;
    setText(editing.text);
    const element = textareaRef.current;
    if (element) {
      element.focus();
      element.setSelectionRange(editing.text.length, editing.text.length);
    }
  }, [editing]);
  // Once there is at most one item left — dequeued, removed, or drained on
  // its own — that item belongs inline again, not behind a dialog.
  useEffect(() => {
    if (queue.length <= 1) setQueueOpen(false);
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

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files];
      if (list.length === 0) return;
      setUploadError(null);
      setUploading((count) => count + list.length);
      for (const file of list) {
        const result = await chatClient.uploadAttachment(tenantId, { chatId }, file);
        setUploading((count) => count - 1);
        const attachment = result.data;
        if (result.error || !attachment) {
          setUploadError(`${file.name}: ${result.error ?? 'upload failed'}`);
          continue;
        }
        setAttachments((current) => [...current, attachment]);
      }
    },
    [chatId, tenantId]
  );

  const remove = useCallback(
    async (attachment: AttachmentView) => {
      setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
      await chatClient.deleteAttachment(tenantId, attachment.id);
    },
    [tenantId]
  );

  const send = useCallback(async () => {
    const trimmed = text.trim();
    // Sending while running is not blocked here — the caller (onSubmit)
    // queues it and returns true; only an actually-empty box or an
    // in-flight upload stops the person from queuing.
    if ((!trimmed && attachments.length === 0) || disabled || uploading > 0) return;
    const ok = await onSubmit({ text: trimmed, attachments });
    if (ok) {
      setText('');
      setAttachments([]);
    }
  }, [text, attachments, disabled, uploading, onSubmit]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === '/' && text === '') {
      event.preventDefault();
      setPrompts(true);
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
    setDragging(false);
    if (uploads && event.dataTransfer.files?.length) void upload(event.dataTransfer.files);
  };

  return (
    <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-900/60">
      {editing ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <Icon path={ICONS.pencil} className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Editing an earlier message. Sending it replaces every reply after it.
          </span>
          <button
            type="button"
            onClick={() => {
              setText('');
              onCancelEdit();
            }}
            className="rounded px-1.5 py-0.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {queue.length === 1 ? (
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
      ) : queue.length > 1 ? (
        <button
          type="button"
          onClick={() => setQueueOpen(true)}
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
        <Modal title={`Queued (${queue.length})`} onClose={() => setQueueOpen(false)}>
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
          if (uploads) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border bg-white transition dark:bg-gray-900 ${
          dragging
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
            : 'border-gray-300 dark:border-gray-700'
        }`}
      >
        {attachments.length > 0 || uploading > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                tenantId={tenantId}
                attachment={attachment}
                onRemove={() => void remove(attachment)}
              />
            ))}
            {uploading > 0 ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                Uploading {uploading}…
              </span>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (uploads && files.length > 0) {
              event.preventDefault();
              void upload(files);
            }
          }}
          placeholder={
            dictating
              ? hearing
                ? 'Listening…'
                : 'Speak, then pause — your words land here to edit and send'
              : running
                ? 'Replying… Enter queues the next message'
                : 'Message Renkei'
          }
          rows={1}
          disabled={disabled}
          aria-label="Message"
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none disabled:opacity-60"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          {uploads ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach a file"
              title="Attach a file"
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
              if (event.target.files) void upload(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => setPrompts(true)}
            aria-label="Insert a prompt"
            title="Prompt libraries"
            disabled={disabled}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.sparkle} className="h-5 w-5" />
          </button>
          {voiceControl}
          {dictation ? (
            <button
              type="button"
              onClick={() => (dictating ? stopDictation() : void startDictation())}
              aria-pressed={dictating}
              aria-label={dictating ? 'Stop dictating' : 'Dictate'}
              title={dictating ? 'Stop dictating' : 'Dictate: speak into the box'}
              disabled={disabled}
              className={`flex items-center justify-center rounded-md p-1.5 disabled:opacity-40 ${
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
          <div className="min-w-0 flex-1">{modelControl}</div>
          {running ? (
            <button
              type="button"
              onClick={() => void send()}
              aria-label="Queue this message"
              title="Sends once the current reply finishes"
              disabled={disabled || uploading > 0 || (!text.trim() && attachments.length === 0)}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
            >
              <Icon path={ICONS.send} className="h-5 w-5" />
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              onClick={() => void onStop()}
              aria-label="Stop"
              className="rounded-md bg-gray-900 p-1.5 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
            >
              <Icon path={ICONS.stop} className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              aria-label="Send"
              disabled={disabled || uploading > 0 || (!text.trim() && attachments.length === 0)}
              className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <Icon path={ICONS.send} className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
      {uploadError ? <p className="mt-1 text-xs text-red-600">{uploadError}</p> : null}
      {dictationError ? <p className="mt-1 text-xs text-red-600">{dictationError}</p> : null}
      <p className="mt-1 hidden text-[11px] text-gray-400 sm:block">
        Enter to send, Shift+Enter for a new line, / for a prompt.
      </p>
      {prompts ? (
        <PromptPicker
          tenantId={tenantId}
          onClose={() => {
            setPrompts(false);
            textareaRef.current?.focus();
          }}
          onPick={(body) => {
            setText((current) => (current ? `${current}\n${body}` : body));
            setPrompts(false);
            textareaRef.current?.focus();
          }}
          onCompact={() => {
            setPrompts(false);
            void onCompact();
          }}
        />
      ) : null}
    </div>
  );
}
