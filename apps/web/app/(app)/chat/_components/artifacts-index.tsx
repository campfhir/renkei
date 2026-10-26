'use client';

/**
 * The Artifacts page: everything this person owns — uploads and the
 * files their chats generated — and everything shared with them, each
 * with where it is used; the whole page a drop target. The list is one
 * page of the library, chosen on the server by what the URL says
 * (artifact-library-params.ts): the search looks at names and at the
 * digest the organization's model wrote for each file, the filters
 * narrow, the pager turns, and each change is a navigation, so the
 * browser is sent no more than it shows and a page is a link. The list
 * scrolls inside its own box, so the filters and the pager stay put.
 * On a wide screen one file is selected at a time, with its details
 * and acts beside the list; on a phone the list is a column of cards
 * and a tap opens the file's details over it, with a back button to the
 * list — the way the code pane opens a file as a tab. What the viewer
 * may do follows artifact-access.ts: an owner renames, replaces, shares,
 * hands over or deletes; a person it was shared with uses it, copies it
 * or takes it off their own list.
 */

import { useCallback, useEffect, useRef, useState, useTransition, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import DownloadLink from '@/components/download-link';
import LocalTime from '@/components/local-time';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import {
  libraryQueryString,
  type LibraryFilters,
  type LibraryQuery,
  type LibraryShow,
} from '@/lib/chat/artifact-library-params';
import type { LibraryPage } from '@/lib/chat/artifact-library-query';
import { useMediaQuery } from '@/lib/use-media-query';
import ShareModal from './share-modal';
import AttachArtifactsPicker from './attach-to-project-modal';
import { CopyArtifactModal, DeleteArtifactModal, RenameArtifactModal } from './artifact-dialogs';
import { BulkAddModal, BulkDeleteModal } from './artifact-bulk-dialogs';
import ArtifactUploadModal, { type UploadTransfer } from './artifact-upload-modal';
import OcrPanel, { canRunOcr } from './artifact-ocr-panel';

/** How often the page is read again while an OCR run is in flight, to move its progress. */
const OCR_POLL_MS = 3000;
import { ModeToggle, sizeOf, statusFor, TypeBadge, isPicture } from './artifact-bits';

/**
 * Below Tailwind's `md` the details open over the list instead of beside
 * it — the same width the list's rows turn into cards at.
 */
const NARROW = '(max-width: 767.98px)';
/** Typing pauses this long before the search is asked for. */
const SEARCH_DEBOUNCE_MS = 300;

const PATH = '/chat/artifacts';

const pagerButton =
  'flex h-7 w-7 items-center justify-center rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900';
const smallButton =
  'rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';

const filtersOf = (query: LibraryQuery): LibraryFilters => ({
  show: query.show,
  projectId: query.projectId,
  query: query.query,
});
const keyOf = (filters: LibraryFilters) =>
  `${filters.show}|${filters.projectId ?? ''}|${filters.query}`;

/** What the digest's state says in the details, or null when it says nothing worth a line. */
function digestLabel(status: string, picture: boolean): string | null {
  switch (status) {
    case 'pending':
    case 'running':
      return picture ? 'Describing the picture…' : 'Summary on its way…';
    case 'failed':
      return picture
        ? 'No description could be written for this picture.'
        : 'No summary could be written for this file.';
    case 'none':
      return picture ? 'Nothing to describe.' : 'No text to summarize.';
    default:
      return null;
  }
}

export default function ArtifactsIndex({
  page,
  query,
  uploads,
  digests,
  projects,
  selectedId,
}: {
  /** The page the server chose for `query`. */
  page: LibraryPage;
  /** What the URL asked for, as the server read it. */
  query: LibraryQuery;
  uploads: boolean;
  /** Whether the organization has the model write a digest for each file (admin → Settings). */
  digests: boolean;
  projects: { id: string; name: string; kind: string }[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const narrow = useMediaQuery(NARROW);
  const [isPending, startTransition] = useTransition();
  const items = page.artifacts;
  // The filters as typed: the URL follows them, debounced for the
  // search box, and they follow the URL when it changes under them (the
  // back button) — told apart by the key of the last navigation asked for.
  const [filters, setFilters] = useState<LibraryFilters>(() => filtersOf(query));
  const asked = useRef(keyOf(filtersOf(query)));
  const latest = useRef(filters);
  latest.current = filters;
  const serverKey = keyOf(filtersOf(query));
  const served = useRef(query);
  served.current = query;
  // Keyed on the string, not the object: a re-render with the same
  // answer must not reset what is being typed.
  useEffect(() => {
    if (serverKey !== asked.current) {
      asked.current = serverKey;
      setFilters(filtersOf(served.current));
    }
  }, [serverKey]);
  const [selected, setSelected] = useState<string | null>(selectedId);
  // The selected file as last seen, so its details stay while a page it
  // is not on is shown — a filter that hides it, an upload's reveal in flight.
  const [remembered, setRemembered] = useState<LibraryItem | null>(
    () => page.artifacts.find((item) => item.id === selectedId) ?? null
  );
  const [dragging, setDragging] = useState(false);
  /** The upload in flight, or null when none is: its progress shows in a modal. */
  const [transfer, setTransfer] = useState<UploadTransfer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    'share' | 'delete' | 'copy' | 'rename' | 'attach' | 'replace' | null
  >(null);
  // Select mode shows a checkmark on every row, and a click on a row ticks
  // it instead of opening its details. The rows ticked for a bulk act, and
  // the one-at-a-time detach in flight ("file:project"), so a second click
  // on it does nothing.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState<'add' | 'delete' | null>(null);
  const [detaching, setDetaching] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dragDepth = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Asks the server for a page: the URL changes, the page re-renders with it. */
  const navigate = useCallback(
    (next: LibraryFilters, toPage: number, focus: string | null = null) => {
      asked.current = keyOf(next);
      startTransition(() => {
        router.replace(`${PATH}${libraryQueryString(next, toPage, focus)}`, { scroll: false });
      });
      listRef.current?.scrollTo({ top: 0 });
    },
    [router]
  );
  /** The same page again, after an act changed what is on it. */
  const reload = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);
  // While a read is in flight the page is read again, so its progress and
  // estimate move; it stops once nothing on the page is being read.
  const ocrRunning = items.some((item) => item.ocr !== null);
  useEffect(() => {
    if (!ocrRunning) return;
    const timer = setInterval(reload, OCR_POLL_MS);
    return () => clearInterval(timer);
  }, [ocrRunning, reload]);
  // A new page of the library is the server's answer to a detach, so the
  // one in flight is over.
  useEffect(() => {
    setDetaching(null);
  }, [page]);

  // A filter change starts over at the first page of what it shows; the
  // search box waits for typing to pause.
  const filter = (patch: Partial<LibraryFilters>) => {
    const next = { ...latest.current, ...patch };
    setFilters(next);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if ('query' in patch) {
      searchTimer.current = setTimeout(() => navigate(next, 1), SEARCH_DEBOUNCE_MS);
    } else {
      navigate(next, 1);
    }
  };
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );
  const goTo = (toPage: number) =>
    navigate(latest.current, Math.max(1, Math.min(page.pageCount, toPage)));
  /** Selects a file and turns to the page it is on. */
  const reveal = (id: string) => {
    setSelected(id);
    navigate(latest.current, 1, id);
  };
  const select = (item: LibraryItem | null) => {
    setSelected(item?.id ?? null);
    if (item) setRemembered(item);
  };

  const onPage = items.find((item) => item.id === selected) ?? null;
  const pickedItems = items.filter((item) => picked.includes(item.id));
  const current = onPage ?? (remembered?.id === selected ? remembered : null);
  useEffect(() => {
    if (onPage) setRemembered(onPage);
  }, [onPage]);

  /**
   * Sends each file in turn with a progress bar over all of them. The page
   * stays on the table: when the last file is answered the table is read
   * again, and any file that failed is named in the error line.
   */
  const upload = async (list: FileList | File[] | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    setError(null);
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      const before = sent;
      setTransfer({
        count: files.length,
        index: index + 1,
        name: file.name,
        loaded: before,
        bytes,
      });
      const result = await chatClient.uploadArtifact({}, file, (loaded) => {
        setTransfer((current) => current && { ...current, loaded: before + loaded });
      });
      sent = before + file.size;
      if (result.error) failures.push(`${file.name}: ${result.error}`);
    }
    setTransfer(null);
    if (failures.length > 0) setError(failures.join('; '));
    reload();
  };

  const replace = async (file: File | null) => {
    if (!file || !current) return;
    setError(null);
    const result = await chatClient.replaceArtifact(current.id, file);
    if (result.error) setError(result.error);
    reload();
  };

  const setMode = async (item: LibraryItem, projectId: string, mode: 'always' | 'on_demand') => {
    setError(null);
    const result = await chatClient.setArtifactMode(projectId, item.id, mode);
    if (result.error) setError(result.error);
    reload();
  };

  const detach = async (item: LibraryItem, projectId: string) => {
    const key = `${item.id}:${projectId}`;
    if (detaching === key) return;
    setDetaching(key);
    setError(null);
    const result = await chatClient.detachArtifact(projectId, item.id);
    if (result.error) {
      setError(result.error);
      setDetaching(null);
    }
    reload();
  };

  const togglePick = (id: string) =>
    setPicked((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));

  /** Asks for a read of each file in turn; each one then goes on in the background. */
  const runOcrOn = async (list: LibraryItem[]) => {
    setError(null);
    const failures: string[] = [];
    for (const item of list) {
      const result = await chatClient.startArtifactOcr(item.id);
      if (result.error) failures.push(`${item.filename}: ${result.error}`);
    }
    if (failures.length > 0) setError(failures.join('; '));
    reload();
  };

  const leave = async (item: LibraryItem) => {
    setError(null);
    const result = await chatClient.deleteArtifact(item.id);
    if (result.error) setError(result.error);
    select(null);
    reload();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (uploads && event.dataTransfer.files?.length) void upload(event.dataTransfer.files);
  };

  const tab = (value: LibraryShow, label: string) => (
    <button
      type="button"
      onClick={() => filter({ show: value })}
      className={`flex h-7 items-center rounded-md px-2.5 text-xs font-medium ${
        filters.show === value
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-950 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {label}
    </button>
  );

  // The selected file's details and acts: beside the list on a wide
  // screen, over it on a phone — the one body in both places.
  const details = current ? (
    <>
      <div className="flex items-start gap-3 p-4">
        <TypeBadge filename={current.filename} contentType={current.contentType} large />
        <div className="min-w-0 flex-1">
          <DownloadLink
            href={chatClient.attachmentUrl(current.id)}
            filename={current.filename}
            className="block font-semibold break-words hover:underline"
          >
            {current.filename}
          </DownloadLink>
          <p className="text-xs text-gray-500">
            {sizeOf(current.sizeBytes)} · {current.origin === 'model' ? 'generated' : 'uploaded'}{' '}
            <LocalTime at={current.createdAt} format="date" /> ·{' '}
            {current.via === 'owner' ? 'owned by you' : `${current.ownerName ?? 'someone'}’s`}
          </p>
          <p className="mt-1 text-xs">
            {statusFor(current.extractStatus, current.contentType) ? (
              <span className="text-amber-700 dark:text-amber-400">
                {statusFor(current.extractStatus, current.contentType)}
              </span>
            ) : (
              <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                Ready to read
              </span>
            )}
          </p>
        </div>
        {!narrow ? (
          <button
            type="button"
            onClick={() => select(null)}
            aria-label="Close details"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.close} className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {digests || current.summary || current.keywords.length > 0 ? (
        <section
          aria-label="About this file"
          className="border-t border-gray-100 px-4 py-3 dark:border-gray-900"
        >
          <h3 className="mb-2 text-xs font-semibold text-gray-500">About</h3>
          {current.summary ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">{current.summary}</p>
          ) : (
            <p className="text-xs text-gray-500">
              {digestLabel(current.digestStatus, isPicture(current.contentType))}
            </p>
          )}
          {current.keywords.length > 0 ? (
            <ul aria-label="Keywords" className="mt-2 flex flex-wrap gap-1">
              {current.keywords.map((keyword) => (
                <li key={keyword}>
                  <button
                    type="button"
                    onClick={() => {
                      if (narrow) select(null);
                      filter({ query: keyword });
                    }}
                    title={`Search for “${keyword}”`}
                    className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    {keyword}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {current.ocrSupported || current.ocr || current.ocrPages !== null ? (
        // Keyed on the run, so a new run starts its clock from its own snapshot.
        <OcrPanel
          key={`${current.id}:${current.ocr?.startedAt ?? ''}`}
          item={current}
          digests={digests}
          onStart={async (item) => {
            setError(null);
            const result = await chatClient.startArtifactOcr(item.id);
            if (result.error) setError(result.error);
            reload();
          }}
        />
      ) : null}

      <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">Used in</h3>
        {current.projects.length === 0 ? (
          <p className="text-xs text-gray-500">
            {current.chat
              ? 'In its chat only; it goes when the chat does unless a project takes it.'
              : 'Not attached to a project.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {current.projects.map((project) => (
              <li key={project.id} className="flex items-center gap-2 text-sm">
                <Icon
                  path={project.kind === 'code' ? ICONS.code : ICONS.pages}
                  className="h-3.5 w-3.5 shrink-0 text-gray-400"
                />
                <Link
                  href={
                    project.kind === 'code' ? `/code/${project.id}` : `/chat/projects/${project.id}`
                  }
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {project.name}
                </Link>
                <ModeToggle
                  label={`How ${project.name} uses ${current.filename}`}
                  value={project.mode}
                  onChange={(mode) => void setMode(current, project.id, mode)}
                />
                <button
                  type="button"
                  onClick={() => void detach(current, project.id)}
                  disabled={detaching === `${current.id}:${project.id}`}
                  aria-label={`Detach from ${project.name}`}
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-gray-900"
                >
                  <Icon path={ICONS.close} className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {current.chat ? (
          <p className="mt-2 text-xs text-gray-500">
            From the chat{' '}
            <Link href={`/chat/${current.chat.id}`} className="hover:underline">
              {current.chat.title ?? 'Untitled'}
            </Link>
          </p>
        ) : null}
        {projects.length > 0 && (current.via === 'owner' || current.via === 'grant') ? (
          <button
            type="button"
            onClick={() => setDialog('attach')}
            className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            + Attach to a project…
          </button>
        ) : null}
      </div>

      <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">Access</h3>
        <p className="text-xs text-gray-500">
          {current.via === 'owner'
            ? `You own it${current.sharedWith > 0 ? `; shared with ${current.sharedWith} ${current.sharedWith === 1 ? 'person' : 'people'}` : ''}. ${current.projects.length > 0 ? 'Everyone in the projects above reads it; their owners and editors may detach it.' : ''}`
            : current.via === 'grant'
              ? 'Shared with you: use it in your own projects, read it, copy it. Only its owner changes it.'
              : 'You read it through a project or chat it is used in.'}
        </p>
        {current.via === 'owner' ? (
          <button
            type="button"
            onClick={() => setDialog('share')}
            className={`mt-2 inline-flex items-center gap-1 ${smallButton}`}
          >
            <Icon path={ICONS.share} className="h-3.5 w-3.5" />
            Share…
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <DownloadLink
          href={chatClient.attachmentUrl(current.id)}
          filename={current.filename}
          className={`inline-flex items-center gap-1 ${smallButton}`}
        >
          <Icon path={ICONS.download} className="h-3.5 w-3.5" />
          Download
        </DownloadLink>
        {current.via === 'owner' ? (
          <>
            <button
              type="button"
              onClick={() => replaceInput.current?.click()}
              className={smallButton}
            >
              Replace file…
            </button>
            <input
              ref={replaceInput}
              type="file"
              className="hidden"
              aria-label="Replace the file"
              onChange={(event) => {
                void replace(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />
            <button type="button" onClick={() => setDialog('rename')} className={smallButton}>
              Rename
            </button>
            <button
              type="button"
              onClick={() => setDialog('delete')}
              className="ml-auto text-xs text-red-600 hover:underline dark:text-red-400"
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setDialog('copy')}
              className={`inline-flex items-center gap-1 ${smallButton}`}
            >
              <Icon path={ICONS.copy} className="h-3.5 w-3.5" />
              Make a copy I own
            </button>
            {current.via === 'grant' ? (
              <button
                type="button"
                onClick={() => void leave(current)}
                className="ml-auto text-xs text-red-600 hover:underline dark:text-red-400"
                title={`Keeps ${current.ownerName ?? 'the owner'}’s file`}
              >
                Remove from my artifacts
              </button>
            ) : null}
          </>
        )}
      </div>
      <p className="px-4 pb-3 text-xs text-gray-500">
        {current.via === 'owner'
          ? 'Replacing keeps every attachment and re-reads the text. Deleting shows who loses it and offers to hand it over instead.'
          : 'A copy is a separate file you own; the owner is told. Removing it keeps their file and their shares.'}
      </p>
    </>
  ) : null;

  const dialogs = (
    <>
      {dialog === 'share' && current ? (
        <ShareModal
          kind="artifact"
          resourceId={current.id}
          title={`Share ${current.filename}`}
          onClose={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
      {bulk === 'add' && pickedItems.length > 0 ? (
        <BulkAddModal
          items={pickedItems}
          projects={projects}
          onDone={reload}
          onClose={() => setBulk(null)}
        />
      ) : null}
      {bulk === 'delete' && pickedItems.length > 0 ? (
        <BulkDeleteModal items={pickedItems} onDone={reload} onClose={() => setBulk(null)} />
      ) : null}
      {transfer ? <ArtifactUploadModal transfer={transfer} /> : null}
      {dialog === 'delete' && current ? (
        <DeleteArtifactModal
          item={current}
          onDone={() => {
            select(null);
            reload();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'copy' && current ? (
        <CopyArtifactModal
          item={current}
          projects={projects}
          onDone={(artifactId) => reveal(artifactId)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'rename' && current ? (
        <RenameArtifactModal item={current} onDone={reload} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'attach' && current ? (
        <AttachArtifactsPicker
          item={current}
          projects={projects}
          onDone={reload}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );

  // A phone with a file open: its details fill the page, the list behind
  // them one tap back.
  if (narrow && current) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-200 pr-3 dark:border-gray-800">
          <button
            type="button"
            onClick={() => select(null)}
            aria-label="Back to artifacts"
            className="flex h-12 w-12 shrink-0 items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-900 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.chevronLeft} className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{current.filename}</h1>
        </div>
        <aside aria-label="Selected artifact" className="min-h-0 flex-1 overflow-y-auto">
          {details}
        </aside>
        {error ? (
          <p
            role="alert"
            className="border-t border-gray-200 px-4 py-2 text-sm text-red-600 dark:border-gray-800"
          >
            {error}
          </p>
        ) : null}
        {dialogs}
      </div>
    );
  }

  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.total, page.page * page.pageSize);
  const searching = filters.query.trim().length > 0;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        if (uploads) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <h1 className="flex-1 text-sm font-semibold">Artifacts</h1>
        {uploads ? (
          <>
            <button
              type="button"
              disabled={transfer !== null}
              onClick={() => fileInput.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Icon path={ICONS.upload} className="h-4 w-4" />
              {transfer !== null ? 'Uploading…' : 'Upload'}
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
          </>
        ) : null}
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 p-4">
        <p className="hidden shrink-0 text-sm text-gray-600 md:block dark:text-gray-400">
          Files you upload and files chats generate: manuals, design docs, style guides, reports.
          Stored once, under you, outside every repository; a project holds one by reference, so the
          same file serves any number of projects.
          {digests ? ' Search finds a file by its name or by what it is about.' : ''}
          {!uploads
            ? ' File storage is not set up for this organization, so nothing can be uploaded yet.'
            : ''}
        </p>
        {!uploads ? (
          <p className="shrink-0 text-sm text-gray-600 md:hidden dark:text-gray-400">
            File storage is not set up for this organization, so nothing can be uploaded yet.
          </p>
        ) : null}

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <input
            type="search"
            value={filters.query}
            onChange={(event) => filter({ query: event.target.value })}
            placeholder={digests ? 'Search names and contents…' : 'Search names…'}
            aria-label="Search artifacts"
            className="w-64 max-w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div
            className="flex shrink-0 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
            role="group"
            aria-label="Show"
          >
            {tab('all', 'All')}
            {tab('uploaded', 'Uploaded')}
            {tab('generated', 'Generated')}
            {tab('shared', 'Shared with me')}
          </div>
          {projects.length > 0 ? (
            <select
              value={filters.projectId ?? ''}
              onChange={(event) => filter({ projectId: event.target.value || null })}
              aria-label="Used in project"
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">Any project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
          <span className="ml-auto text-xs text-gray-500">
            {page.owned.count} of yours · {sizeOf(page.owned.bytes)}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-stretch gap-4">
          <section
            aria-label="Artifacts"
            aria-busy={isPending}
            className={`flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-gray-200 transition-opacity dark:border-gray-800 ${isPending ? 'opacity-60' : ''}`}
          >
            <div className="flex h-9 shrink-0 items-center justify-end border-b border-gray-200 px-3 dark:border-gray-800">
              <button
                type="button"
                aria-pressed={selecting}
                onClick={() => {
                  setSelecting(!selecting);
                  setPicked([]);
                }}
                className={smallButton}
              >
                {selecting ? 'Done selecting' : 'Select'}
              </button>
            </div>
            {items.length === 0 ? (
              <p className="p-4 text-sm text-gray-500">
                {page.libraryCount === 0
                  ? 'No artifacts yet. Upload a manual, a guide or a design doc, or drop one anywhere on this page; files your chats write land here on their own.'
                  : searching && digests
                    ? 'Nothing matches. Search looks at file names and at the summary and keywords written for each file.'
                    : 'Nothing matches.'}
              </p>
            ) : (
              // Rows on a wide screen; cards, each a door to the file's
              // details, on a phone.
              <ul
                ref={listRef}
                className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto max-md:space-y-1.5 max-md:divide-y-0 max-md:p-2 dark:divide-gray-900"
              >
                {items.map((item) => {
                  const status = item.ocr
                    ? 'OCR running'
                    : statusFor(item.extractStatus, item.contentType);
                  const isSelected = item.id === selected;
                  const ticked = picked.includes(item.id);
                  // In select mode the whole row is the checkmark: a click
                  // ticks or unticks it and never opens the details.
                  const highlighted = selecting ? ticked : isSelected;
                  return (
                    <li
                      key={item.id}
                      data-artifact={item.id}
                      className="max-md:overflow-hidden max-md:rounded-md max-md:border max-md:border-gray-200 max-md:dark:border-gray-800"
                    >
                      <div className="flex items-center">
                        {selecting ? (
                          <input
                            type="checkbox"
                            checked={ticked}
                            onChange={() => togglePick(item.id)}
                            aria-label={`Select ${item.filename}`}
                            className="ml-3 h-4 w-4 shrink-0 rounded border-gray-300"
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            selecting
                              ? togglePick(item.id)
                              : select(isSelected && !narrow ? null : item)
                          }
                          aria-current={!selecting && isSelected ? 'true' : undefined}
                          aria-pressed={selecting ? ticked : undefined}
                          className={`flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-900 ${highlighted ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}
                        >
                          <TypeBadge filename={item.filename} contentType={item.contentType} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{item.filename}</span>
                            <span className="block truncate text-xs text-gray-500">
                              {sizeOf(item.sizeBytes)}
                              {status ? (
                                <>
                                  {' · '}
                                  <span className="text-amber-700 dark:text-amber-400">
                                    {status}
                                  </span>
                                </>
                              ) : null}
                              {item.origin === 'model'
                                ? ' · generated'
                                : item.chat
                                  ? ' · uploaded'
                                  : ''}
                              {item.chat ? ` in “${item.chat.title ?? 'a chat'}”` : ''}
                              {item.ownerName ? ` · shared by ${item.ownerName}` : ''}
                              {' · '}
                              <LocalTime at={item.createdAt} format="date" />
                            </span>
                            {item.summary ? (
                              <span className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                                {item.summary}
                              </span>
                            ) : null}
                          </span>
                          <span className="hidden min-w-0 max-w-[14rem] shrink-0 flex-wrap justify-end gap-1 md:flex">
                            {item.projects.length === 0 ? (
                              item.chat ? (
                                <span
                                  className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
                                  title={`In the chat “${item.chat.title ?? 'Untitled'}” only`}
                                >
                                  <Icon path={ICONS.chat} className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{item.chat.title ?? 'a chat'}</span>
                                </span>
                              ) : (
                                <span className="text-xs text-gray-400">Not attached</span>
                              )
                            ) : (
                              item.projects.slice(0, 2).map((project) => (
                                <span
                                  key={project.id}
                                  className="truncate rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
                                >
                                  {project.name}
                                </span>
                              ))
                            )}
                            {item.projects.length > 2 ? (
                              <span className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
                                +{item.projects.length - 2}
                              </span>
                            ) : null}
                          </span>
                          <Icon
                            path={ICONS.chevron}
                            className="h-4 w-4 shrink-0 text-gray-400 md:hidden"
                          />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {selecting ? (
              // Below the list, so the rows above it stay where they are when
              // a file is ticked; on a phone it wraps under the list.
              <div
                role="toolbar"
                aria-label="Selected artifacts"
                className="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-200 px-3 py-2 text-sm dark:border-gray-800"
              >
                <span className="font-medium">
                  {pickedItems.length > 0
                    ? `${pickedItems.length} selected`
                    : 'Tap files to select'}
                </span>
                <button
                  type="button"
                  disabled={pickedItems.length === 0}
                  onClick={() => setBulk('add')}
                  className={`${smallButton} disabled:opacity-40`}
                >
                  Add to project…
                </button>
                <button
                  type="button"
                  disabled={!pickedItems.some(canRunOcr)}
                  onClick={() => void runOcrOn(pickedItems.filter(canRunOcr))}
                  className={`${smallButton} disabled:opacity-40`}
                >
                  Run OCR
                </button>
                <button
                  type="button"
                  disabled={pickedItems.length === 0}
                  onClick={() => setBulk('delete')}
                  className={`${smallButton} disabled:opacity-40`}
                >
                  Delete…
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(items.map((item) => item.id))}
                  className="text-xs text-gray-500 hover:underline"
                >
                  Select all on this page
                </button>
                <button
                  type="button"
                  onClick={() => setPicked([])}
                  disabled={pickedItems.length === 0}
                  className="ml-auto text-xs text-gray-500 hover:underline disabled:opacity-40 disabled:hover:no-underline"
                >
                  Clear
                </button>
              </div>
            ) : null}
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-800">
              {uploads ? (
                <span className="hidden items-center gap-2 md:flex">
                  <Icon path={ICONS.upload} className="h-3.5 w-3.5" />
                  Drop files anywhere on this page to add them · any type
                </span>
              ) : null}
              {page.total > 0 ? (
                <nav aria-label="Pages" className="ml-auto flex items-center gap-2">
                  <span>
                    {first}–{last} of {page.total}
                  </span>
                  {page.pageCount > 1 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => goTo(page.page - 1)}
                        disabled={page.page <= 1 || isPending}
                        aria-label="Previous page"
                        className={pagerButton}
                      >
                        <Icon path={ICONS.chevronLeft} className="h-4 w-4" />
                      </button>
                      <span>
                        Page {page.page} of {page.pageCount}
                      </span>
                      <button
                        type="button"
                        onClick={() => goTo(page.page + 1)}
                        disabled={page.page >= page.pageCount || isPending}
                        aria-label="Next page"
                        className={pagerButton}
                      >
                        <Icon path={ICONS.chevron} className="h-4 w-4" />
                      </button>
                    </>
                  ) : null}
                </nav>
              ) : null}
            </div>
          </section>

          {current ? (
            <aside
              aria-label="Selected artifact"
              className="hidden w-[320px] shrink-0 overflow-y-auto rounded-lg border border-gray-200 md:block dark:border-gray-800"
            >
              {details}
            </aside>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="shrink-0 text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </div>

      {dragging && uploads ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-blue-500 bg-blue-50/95 text-blue-700 dark:bg-blue-950/90 dark:text-blue-300">
          <Icon path={ICONS.upload} className="h-8 w-8" />
          <p className="text-lg font-semibold">Drop to add to your artifacts</p>
          <p className="text-sm">PDF, Office, images, code, text — anything goes</p>
        </div>
      ) : null}

      {dialogs}
    </div>
  );
}
