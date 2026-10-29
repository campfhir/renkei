'use client';

/**
 * A project's artifacts, on its page: what it holds, how its chats use
 * each (Always, in full every turn, against a budget; On demand, searched
 * and read when asked), where else each lives, and the three ways in —
 * attach from the library, upload, drop. Owners and editors change it;
 * viewers read it. The data is the page's (project-view.ts); every change
 * goes through the API and refreshes the page. A project can hold hundreds
 * (a batch dropped in at once), so the list shows them a page at a time.
 */

import { useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import DownloadLink from '@/components/download-link';
import { chatClient } from '@/lib/chat/client';
import type { ProjectArtifactView } from '@/lib/chat/views';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import AttachArtifactsModal from './attach-artifacts-modal';

/** Rows the list shows at once. */
export const ARTIFACTS_PAGE_SIZE = 10;

const pagerButton =
  'flex h-7 w-7 items-center justify-center rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900';
import { ModeToggle, sizeOf, statusLabel, tokensLabel, TypeBadge } from './artifact-bits';

export default function ArtifactsCard({
  projectId,
  projectName,
  files: serverFiles,
  alwaysTokens,
  canEdit,
  viewerSubject,
  className,
}: {
  projectId: string;
  projectName: string;
  files: ProjectArtifactView[];
  alwaysTokens: { used: number; budget: number };
  canEdit: boolean;
  viewerSubject: string;
  className: string;
}) {
  const router = useRouter();
  const anchor = useCoachAnchor('project-files');
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Files taken off the list before the server has said so: a second click
  // on the same row then finds nothing to do, instead of a 404.
  const [removing, setRemoving] = useState<string[]>([]);
  const files = serverFiles.filter((file) => !removing.includes(file.id));
  useEffect(() => {
    setRemoving([]);
  }, [serverFiles]);
  // 1-based; held inside the list as it shrinks (a detach on the last page).
  const [pageAsked, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(files.length / ARTIFACTS_PAGE_SIZE));
  const page = Math.min(pageAsked, pageCount);
  const firstIndex = (page - 1) * ARTIFACTS_PAGE_SIZE;
  const shown = files.slice(firstIndex, firstIndex + ARTIFACTS_PAGE_SIZE);

  const upload = async (list: FileList | File[] | null) => {
    const items = list ? [...list] : [];
    if (items.length === 0) return;
    setError(null);
    setUploading(items.length);
    for (const file of items) {
      const result = await chatClient.uploadArtifact({ projectId }, file);
      if (result.error) setError(`${file.name}: ${result.error}`);
      setUploading((count) => count - 1);
    }
    router.refresh();
  };

  const setMode = async (file: ProjectArtifactView, mode: 'always' | 'on_demand') => {
    setBusyId(file.id);
    setError(null);
    const result = await chatClient.setArtifactMode(projectId, file.id, mode);
    setBusyId(null);
    if (result.error) setError(result.error);
    router.refresh();
  };

  const detach = async (file: ProjectArtifactView) => {
    if (removing.includes(file.id)) return;
    setRemoving((ids) => [...ids, file.id]);
    setError(null);
    const result = await chatClient.detachArtifact(projectId, file.id);
    if (result.error) {
      setError(result.error);
      setRemoving((ids) => ids.filter((id) => id !== file.id));
    }
    router.refresh();
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (canEdit && event.dataTransfer.files?.length) void upload(event.dataTransfer.files);
  };

  const budgetPercent = Math.min(
    100,
    Math.round((alwaysTokens.used / Math.max(1, alwaysTokens.budget)) * 100)
  );
  const onDemandCount = files.filter((file) => file.mode === 'on_demand').length;

  return (
    <section
      className={`${className} ${dragging ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : ''}`}
      aria-label="Artifacts"
      onDragOver={(event) => {
        event.preventDefault();
        if (canEdit) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      {...anchor}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Artifacts</h2>
        <span className="text-xs text-gray-500">
          {files.length === 0 ? 'none attached' : `${files.length} attached`}
        </span>
        {canEdit ? (
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              <Icon path={ICONS.layers} className="h-3.5 w-3.5" />
              Attach from library…
            </button>
            <button
              type="button"
              disabled={uploading > 0}
              onClick={() => fileInput.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              <Icon path={ICONS.upload} className="h-3.5 w-3.5" />
              {uploading > 0 ? `Uploading ${uploading}…` : 'Upload'}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              aria-label="Upload artifacts"
              onChange={(event) => {
                void upload(event.target.files);
                event.target.value = '';
              }}
            />
          </span>
        ) : null}
      </div>
      <p className="mb-2 text-xs text-gray-500">
        Every chat here reads them;{' '}
        {canEdit ? 'owners and editors change them' : 'its owner and editors change them'}. Kept out
        of the repository.{' '}
        <Link href="/chat/artifacts" className="text-blue-600 hover:underline dark:text-blue-400">
          Browse all artifacts
        </Link>
      </p>

      {files.length === 0 ? (
        <p className="text-sm text-gray-500">
          No artifacts yet.{' '}
          {canEdit ? 'Attach one from your library, upload, or drop a file here.' : ''}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-900">
          {shown.map((file) => {
            const status = statusLabel(file.extractStatus);
            const mine = file.ownerSubject === viewerSubject;
            return (
              <li key={file.id} className="flex items-center gap-2.5 py-2" data-artifact={file.id}>
                <TypeBadge filename={file.filename} contentType={file.contentType} />
                <span className="min-w-0 flex-1">
                  <DownloadLink
                    href={chatClient.attachmentUrl(file.id)}
                    filename={file.filename}
                    className="block truncate text-sm font-medium hover:underline"
                    title={`${file.filename} · ${sizeOf(file.sizeBytes)}`}
                  >
                    {file.filename}
                  </DownloadLink>
                  <span className="block truncate text-xs text-gray-500">
                    {status ? (
                      <span className="text-amber-700 dark:text-amber-400">{status}</span>
                    ) : (
                      tokensLabel(file.tokens)
                    )}
                    {file.chat ? (
                      <>
                        {' · '}
                        <Icon path={ICONS.sparkle} className="inline h-3 w-3 align-[-2px]" />{' '}
                        generated in{' '}
                        <Link href={`/chat/${file.chat.id}`} className="hover:underline">
                          {file.chat.title ?? 'a chat'}
                        </Link>
                      </>
                    ) : null}
                    {file.projectsUsing > 1 ? ` · in ${file.projectsUsing} projects` : ''}
                    {file.ownerName ? ` · ${file.ownerName}’s` : ''}
                  </span>
                </span>
                <ModeToggle
                  label={`How this project's chats use ${file.filename}`}
                  value={file.mode}
                  disabled={!canEdit || busyId === file.id}
                  onChange={(mode) => void setMode(file, mode)}
                />
                {canEdit || mine ? (
                  <button
                    type="button"
                    disabled={busyId === file.id}
                    onClick={() => void detach(file)}
                    aria-label={`Remove ${file.filename} from ${projectName}`}
                    data-tip="Detach from this project. The file stays in its owner’s artifacts."
                    className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-900"
                  >
                    <Icon path={ICONS.close} className="h-4 w-4" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {pageCount > 1 ? (
        <nav
          aria-label="Artifact pages"
          className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500"
        >
          <span>
            {firstIndex + 1}–{firstIndex + shown.length} of {files.length}
          </span>
          <button
            type="button"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className={pagerButton}
          >
            <Icon path={ICONS.chevronLeft} className="h-4 w-4" />
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
            className={pagerButton}
          >
            <Icon path={ICONS.chevron} className="h-4 w-4" />
          </button>
        </nav>
      ) : null}

      {files.length > 0 ? (
        <div className="mt-3 border-t border-gray-100 pt-2.5 dark:border-gray-900">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="font-medium text-gray-700 dark:text-gray-300">Always in context</span>
            <span className="text-gray-500">
              {files.length - onDemandCount} file{files.length - onDemandCount === 1 ? '' : 's'} ·{' '}
              {tokensLabel(alwaysTokens.used)} of {tokensLabel(alwaysTokens.budget)} per turn
            </span>
            <span className="ml-auto text-gray-500">{onDemandCount} searched on demand</span>
          </div>
          <div
            role="img"
            aria-label={`${alwaysTokens.used} of ${alwaysTokens.budget} always-in-context tokens used`}
            className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
          >
            <div
              className={`h-full rounded-full ${budgetPercent >= 90 ? 'bg-amber-500' : 'bg-blue-600'}`}
              style={{ width: `${budgetPercent}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            Always: the whole text travels with every turn, best for short guides and conventions.
            On demand: the model searches passages and reads the pages it needs, best for manuals
            and decks.
          </p>
        </div>
      ) : null}

      {canEdit ? (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-gray-300 px-3 py-2.5 text-xs text-gray-500 dark:border-gray-700">
          <Icon path={ICONS.upload} className="h-3.5 w-3.5" />
          Drop files here to upload and attach them to {projectName}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {picking ? (
        <AttachArtifactsModal
          projectId={projectId}
          projectName={projectName}
          attachedIds={files.map((file) => file.id)}
          onAttached={() => router.refresh()}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </section>
  );
}
