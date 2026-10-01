'use client';

/**
 * The line under a file a reply produced — its kind, its name, its size,
 * and the Download that saves it — the same under a document's first page
 * as under a generated picture, so every file in a thread is saved the
 * same way, from right beneath it.
 */

import DownloadLink from '@/components/download-link';
import { Icon, ICONS } from '@/components/icons';

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileCaption({
  href,
  filename,
  sizeBytes,
  icon,
  as: Tag = 'figcaption',
}: {
  href: string;
  filename: string;
  sizeBytes: number;
  icon: string;
  /** 'div' inside a figure that already has its caption (a figure takes only one). */
  as?: 'figcaption' | 'div';
}) {
  return (
    <Tag
      data-testid="file-caption"
      className="mt-1.5 flex max-w-md items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
    >
      <Icon path={icon} className="h-4 w-4 shrink-0 text-gray-400" />
      <span className="min-w-0 truncate font-medium" title={filename}>
        {filename}
      </span>
      <span className="shrink-0 text-gray-400">{sizeOf(sizeBytes)}</span>
      <DownloadLink
        href={href}
        filename={filename}
        aria-label={`Download ${filename}`}
        title={`Download ${filename}`}
        data-testid="artifact-download"
        className="ml-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200"
      >
        <Icon path={ICONS.download} className="h-3.5 w-3.5" />
        Download
      </DownloadLink>
    </Tag>
  );
}
