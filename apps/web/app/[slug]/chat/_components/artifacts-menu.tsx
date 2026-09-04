'use client';

/**
 * The files tools produced in this chat — a screenshot, a rendered PDF, a
 * download — behind one button in the title bar. Each opens a small
 * modal to save it to this device or copy it to a share of the person's
 * own; bytes always stream through the app under a session check, never
 * via a signed URL. Appears only once there is something to list.
 */

import { useCallback, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import type { AttachmentView } from '@/lib/chat/views';
import ArtifactModal from './artifact-modal';

function iconFor(contentType: string): string {
  if (contentType.startsWith('image/')) return ICONS.fileImage;
  if (contentType === 'text/csv' || contentType.includes('spreadsheet')) return ICONS.fileSheet;
  if (contentType.startsWith('text/') || contentType === 'application/pdf') return ICONS.fileText;
  return ICONS.file;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArtifactsMenu({
  tenantId,
  artifacts,
}: {
  tenantId: string;
  artifacts: AttachmentView[];
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<AttachmentView | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  if (artifacts.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Artifacts (${artifacts.length})`}
        title="Files the assistant produced"
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.file} className="h-4 w-4" />
        <span className="hidden sm:inline">Artifacts</span>
        <span className="text-gray-400">{artifacts.length}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-80 max-w-[90vw] rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Files the assistant produced
          </p>
          <ul className="max-h-80 overflow-y-auto">
            {[...artifacts].reverse().map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    setChosen(artifact);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <Icon
                    path={iconFor(artifact.contentType)}
                    className="h-4 w-4 shrink-0 text-gray-400"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{artifact.filename}</span>
                    <span className="block text-[11px] text-gray-500">
                      {sizeOf(artifact.sizeBytes)} · {artifact.contentType}
                    </span>
                  </span>
                  <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {chosen ? (
        <ArtifactModal tenantId={tenantId} artifact={chosen} onClose={() => setChosen(null)} />
      ) : null}
    </div>
  );
}
