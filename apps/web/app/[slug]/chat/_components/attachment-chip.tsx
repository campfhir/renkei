'use client';

import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { AttachmentView } from '@/lib/chat/views';

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AttachmentChip({
  tenantId,
  attachment,
  onRemove,
}: {
  tenantId: string;
  attachment: AttachmentView;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
      <Icon path={ICONS.paperclip} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      <a
        href={chatClient.attachmentUrl(tenantId, attachment.id)}
        className="truncate hover:underline"
        title={`${attachment.filename} · ${sizeOf(attachment.sizeBytes)}`}
      >
        {attachment.filename}
      </a>
      <span className="text-gray-400">{sizeOf(attachment.sizeBytes)}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.filename}`}
          className="rounded-full p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800"
        >
          <Icon path={ICONS.close} className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}
