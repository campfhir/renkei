'use client';

import { useEffect } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { AttachmentView } from '@/lib/chat/views';

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusOf(status: string): string | null {
  if (status === 'done') return null;
  if (status === 'needs_ocr') return 'Waiting for OCR';
  if (status === 'ocr_failed') return 'OCR failed';
  return 'No text';
}

/** Every file attached to the message being written, when there are too many for chips. */
export default function AttachmentListModal({
  tenantId,
  attachments,
  onRemove,
  onClose,
}: {
  tenantId: string;
  attachments: AttachmentView[];
  onRemove: (attachment: AttachmentView) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Attached files"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold">Attached files ({attachments.length})</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.close} className="h-4 w-4" />
          </button>
        </div>
        <ul className="mt-3 min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto text-sm dark:divide-gray-900">
          {attachments.map((attachment) => {
            const status = statusOf(attachment.extractStatus);
            return (
              <li key={attachment.id} className="flex items-center gap-2 py-2">
                <Icon path={ICONS.paperclip} className="h-4 w-4 shrink-0 text-gray-400" />
                <a
                  href={chatClient.attachmentUrl(tenantId, attachment.id)}
                  className="min-w-0 flex-1 truncate hover:underline"
                  title={attachment.filename}
                >
                  {attachment.filename}
                </a>
                {status ? (
                  <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">
                    {status}
                  </span>
                ) : null}
                <span className="shrink-0 text-xs text-gray-400">
                  {sizeOf(attachment.sizeBytes)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(attachment)}
                  aria-label={`Remove ${attachment.filename}`}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.close} className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
