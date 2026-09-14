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
import { chatClient } from '@/lib/chat/client';
import type { AttachmentView } from '@/lib/chat/views';
import AttachmentChip from './attachment-chip';
import PromptPicker from './prompt-picker';

export interface ComposerSubmit {
  text: string;
  attachments: AttachmentView[];
}

const MAX_ROWS = 10;

export default function Composer({
  tenantId,
  chatId,
  ensureChatId,
  disabled,
  running,
  uploads,
  onSubmit,
  onStop,
  modelControl,
  editing,
  onCancelEdit,
}: {
  tenantId: string;
  chatId: string | null;
  /** Creates the chat on first use, so uploads have somewhere to live. */
  ensureChatId: () => Promise<string | null>;
  disabled: boolean;
  running: boolean;
  /** Files can be attached at all — false when the org has no storage. */
  uploads: boolean;
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  onStop: () => Promise<void>;
  modelControl: ReactNode;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      const id = chatId ?? (await ensureChatId());
      if (!id) return;
      setUploading((count) => count + list.length);
      for (const file of list) {
        const result = await chatClient.uploadAttachment(tenantId, { chatId: id }, file);
        setUploading((count) => count - 1);
        const attachment = result.data;
        if (result.error || !attachment) {
          setUploadError(`${file.name}: ${result.error ?? 'upload failed'}`);
          continue;
        }
        setAttachments((current) => [...current, attachment]);
      }
    },
    [chatId, ensureChatId, tenantId]
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
    if ((!trimmed && attachments.length === 0) || disabled || running || uploading > 0) return;
    const ok = await onSubmit({ text: trimmed, attachments });
    if (ok) {
      setText('');
      setAttachments([]);
    }
  }, [text, attachments, disabled, running, uploading, onSubmit]);

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
          placeholder={running ? 'Replying…' : 'Message Renkei'}
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
          <div className="min-w-0 flex-1">{modelControl}</div>
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
        />
      ) : null}
    </div>
  );
}
