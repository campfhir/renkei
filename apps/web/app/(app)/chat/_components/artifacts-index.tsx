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
 * or takes it off their own list. What the page decides from what is
 * pressed and what the server answers is artifacts-index.model.ts.
 */

import { useCallback, useEffect, useReducer, useRef, useTransition, type DragEvent } from 'react';
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
import ArtifactUploadModal from './artifact-upload-modal';
import OcrPanel from './artifact-ocr-panel';
import { ModeToggle, sizeOf, statusFor, TypeBadge } from './artifact-bits';
import {
  acts,
  accessLine,
  canAttach,
  clampPage,
  currentItem,
  detachSends,
  digestLabel,
  emptyMessage,
  failureLine,
  filterStep,
  filtersOf,
  indexReducer,
  initialIndex,
  keepsReading,
  keyOf,
  originWord,
  ownerLabel,
  pager,
  pickedItems as pickedOn,
  rowOrigin,
  rowPress,
  rowProjects,
  seenReading,
  showsAbout,
  toolbar,
  usedInNowhere,
  type IndexAction,
} from './artifacts-index.model';

/** How often the page is read again while an OCR run is in flight, to move its progress. */
const OCR_POLL_MS = 3000;

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
  const [state, dispatch] = useReducer(
    indexReducer,
    { query, items: page.artifacts, selectedId },
    initialIndex
  );
  const { filters, selected, transfer, error, dialog, selecting, bulk, detaching } = state;
  const asked = useRef(keyOf(filtersOf(query)));
  const latest = useRef(state);
  latest.current = state;
  const serverKey = keyOf(filtersOf(query));
  const served = useRef(query);
  served.current = query;
  // Keyed on the string, not the object: a re-render with the same
  // answer must not reset what is being typed.
  useEffect(() => {
    if (serverKey !== asked.current) {
      asked.current = serverKey;
      dispatch({ type: 'urlChanged', filters: filtersOf(served.current) });
    }
  }, [serverKey]);
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
  // estimate move. A finished read is digested after it (artifact-ocr.ts),
  // so a file seen being read here keeps the page reading until its summary
  // lands; it stops once nothing on the page is being read or summarized.
  const readHere = useRef<Set<string>>(new Set());
  readHere.current = seenReading(readHere.current, items);
  const polling = keepsReading(items, digests, readHere.current);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(reload, OCR_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, reload]);
  // A new page of the library is the server's answer to a detach, so the
  // one in flight is over.
  useEffect(() => {
    dispatch({ type: 'pageArrived' });
  }, [page]);

  // A filter change starts over at the first page of what it shows; the
  // search box waits for typing to pause.
  const filter = (patch: Partial<LibraryFilters>) => {
    const step = filterStep(latest.current, patch);
    dispatch({ type: 'filtered', patch });
    // The next keystroke, before a re-render, builds on this one.
    latest.current = { ...latest.current, filters: step.filters };
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (step.debounce) {
      searchTimer.current = setTimeout(() => navigate(step.filters, step.page), SEARCH_DEBOUNCE_MS);
    } else {
      navigate(step.filters, step.page);
    }
  };
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );
  const goTo = (toPage: number) => navigate(latest.current.filters, clampPage(page, toPage));
  /** Selects a file and turns to the page it is on. */
  const reveal = (id: string) => {
    dispatch({ type: 'revealed', id });
    navigate(latest.current.filters, 1, id);
  };
  const select = (item: LibraryItem | null) => dispatch({ type: 'selected', item });

  const current = currentItem(state, items);
  const onPage = items.find((item) => item.id === selected) ?? null;
  const pickedItems = pickedOn(state, items);
  useEffect(() => {
    if (onPage) dispatch({ type: 'seenOnPage', item: onPage });
  }, [onPage]);

  /** Runs one act on the server: its error, if any, in the error line; the page read again. */
  const act = async (call: () => Promise<{ error: string | null }>, then?: IndexAction) => {
    dispatch({ type: 'actSent' });
    const result = await call();
    dispatch({ type: 'actAnswered', error: result.error });
    if (then) dispatch(then);
    reload();
  };

  /**
   * Sends each file in turn with a progress bar over all of them. The page
   * stays on the table: when the last file is answered the table is read
   * again, and any file that failed is named in the error line.
   */
  const upload = async (list: FileList | File[] | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    dispatch({ type: 'actSent' });
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      const before = sent;
      dispatch({
        type: 'transferMoved',
        transfer: { count: files.length, index: index + 1, name: file.name, loaded: before, bytes },
      });
      const result = await chatClient.uploadArtifact({}, file, (loaded) => {
        dispatch({ type: 'transferProgress', loaded: before + loaded });
      });
      sent = before + file.size;
      if (result.error) failures.push(`${file.name}: ${result.error}`);
    }
    dispatch({ type: 'uploadsAnswered', failures });
    reload();
  };

  const replace = async (file: File | null) => {
    if (!file || !current) return;
    await act(() => chatClient.replaceArtifact(current.id, file));
  };

  const setMode = (item: LibraryItem, projectId: string, mode: 'always' | 'on_demand') =>
    act(() => chatClient.setArtifactMode(projectId, item.id, mode));

  const detach = async (item: LibraryItem, projectId: string) => {
    const key = `${item.id}:${projectId}`;
    if (!detachSends(latest.current, key)) return;
    dispatch({ type: 'detachSent', key });
    latest.current = { ...latest.current, detaching: key };
    const result = await chatClient.detachArtifact(projectId, item.id);
    if (result.error) dispatch({ type: 'detachFailed', error: result.error });
    reload();
  };

  /** Asks for a read of each file in turn; each one then goes on in the background. */
  const runOcrOn = async (list: LibraryItem[]) => {
    dispatch({ type: 'actSent' });
    const failures: string[] = [];
    for (const item of list) {
      const result = await chatClient.startArtifactOcr(item.id);
      if (result.error) failures.push(`${item.filename}: ${result.error}`);
    }
    dispatch({ type: 'actAnswered', error: failureLine(failures) });
    reload();
  };

  const leave = (item: LibraryItem) =>
    act(() => chatClient.deleteArtifact(item.id), { type: 'selected', item: null });

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    dispatch({ type: 'dragEnded' });
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
            {sizeOf(current.sizeBytes)} · {originWord(current)}{' '}
            <LocalTime at={current.createdAt} format="date" /> · {ownerLabel(current)}
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

      {showsAbout(current, digests) ? (
        <section
          aria-label="About this file"
          className="border-t border-gray-100 px-4 py-3 dark:border-gray-900"
        >
          <h3 className="mb-2 text-xs font-semibold text-gray-500">About</h3>
          {current.summary ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">{current.summary}</p>
          ) : (
            <p className="text-xs text-gray-500">{digestLabel(current)}</p>
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
          onStart={(item) => act(() => chatClient.startArtifactOcr(item.id))}
        />
      ) : null}

      <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">Used in</h3>
        {current.projects.length === 0 ? (
          <p className="text-xs text-gray-500">{usedInNowhere(current)}</p>
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
        {canAttach(current, projects.length) ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'dialogOpened', dialog: 'attach' })}
            className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            + Attach to a project…
          </button>
        ) : null}
      </div>

      <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">Access</h3>
        <p className="text-xs text-gray-500">{accessLine(current)}</p>
        {acts(current).owner ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'dialogOpened', dialog: 'share' })}
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
        {acts(current).owner ? (
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
            <button
              type="button"
              onClick={() => dispatch({ type: 'dialogOpened', dialog: 'rename' })}
              className={smallButton}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'dialogOpened', dialog: 'delete' })}
              className="ml-auto text-xs text-red-600 hover:underline dark:text-red-400"
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => dispatch({ type: 'dialogOpened', dialog: 'copy' })}
              className={`inline-flex items-center gap-1 ${smallButton}`}
            >
              <Icon path={ICONS.copy} className="h-3.5 w-3.5" />
              Make a copy I own
            </button>
            {acts(current).leave ? (
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
      <p className="px-4 pb-3 text-xs text-gray-500">{acts(current).note}</p>
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
            dispatch({ type: 'dialogClosed' });
            reload();
          }}
        />
      ) : null}
      {bulk === 'add' && pickedItems.length > 0 ? (
        <BulkAddModal
          items={pickedItems}
          projects={projects}
          onDone={reload}
          onClose={() => dispatch({ type: 'bulkClosed' })}
        />
      ) : null}
      {bulk === 'delete' && pickedItems.length > 0 ? (
        <BulkDeleteModal
          items={pickedItems}
          onDone={reload}
          onClose={() => dispatch({ type: 'bulkClosed' })}
        />
      ) : null}
      {transfer ? <ArtifactUploadModal transfer={transfer} /> : null}
      {dialog === 'delete' && current ? (
        <DeleteArtifactModal
          item={current}
          onDone={() => {
            select(null);
            reload();
          }}
          onClose={() => dispatch({ type: 'dialogClosed' })}
        />
      ) : null}
      {dialog === 'copy' && current ? (
        <CopyArtifactModal
          item={current}
          projects={projects}
          onDone={(artifactId) => reveal(artifactId)}
          onClose={() => dispatch({ type: 'dialogClosed' })}
        />
      ) : null}
      {dialog === 'rename' && current ? (
        <RenameArtifactModal
          item={current}
          onDone={reload}
          onClose={() => dispatch({ type: 'dialogClosed' })}
        />
      ) : null}
      {dialog === 'attach' && current ? (
        <AttachArtifactsPicker
          item={current}
          projects={projects}
          onDone={reload}
          onClose={() => dispatch({ type: 'dialogClosed' })}
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

  const pages = pager(page);
  const bar = toolbar(state, items);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        dispatch({ type: 'dragEntered', uploads });
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) dispatch({ type: 'dragEnded' });
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
                onClick={() => dispatch({ type: 'selectModeToggled' })}
                className={smallButton}
              >
                {selecting ? 'Done selecting' : 'Select'}
              </button>
            </div>
            {items.length === 0 ? (
              <p className="p-4 text-sm text-gray-500">
                {emptyMessage(page.libraryCount, filters.query, digests)}
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
                  const ticked = state.picked.includes(item.id);
                  const shownProjects = rowProjects(item.projects);
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
                            onChange={() => dispatch({ type: 'pickToggled', id: item.id })}
                            aria-label={`Select ${item.filename}`}
                            className="ml-3 h-4 w-4 shrink-0 rounded border-gray-300"
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={() => dispatch(rowPress(state, item, narrow))}
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
                              {rowOrigin(item)}
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
                              shownProjects.named.map((project) => (
                                <span
                                  key={project.id}
                                  className="truncate rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
                                >
                                  {project.name}
                                </span>
                              ))
                            )}
                            {shownProjects.more > 0 ? (
                              <span className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
                                +{shownProjects.more}
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
                <span className="font-medium">{bar.label}</span>
                <button
                  type="button"
                  disabled={!bar.anyPicked}
                  onClick={() => dispatch({ type: 'bulkOpened', bulk: 'add' })}
                  className={`${smallButton} disabled:opacity-40`}
                >
                  Add to project…
                </button>
                <button
                  type="button"
                  disabled={bar.ocrTargets.length === 0}
                  onClick={() => void runOcrOn(bar.ocrTargets)}
                  className={`${smallButton} disabled:opacity-40`}
                >
                  Run OCR
                </button>
                <button
                  type="button"
                  disabled={!bar.anyPicked}
                  onClick={() => dispatch({ type: 'bulkOpened', bulk: 'delete' })}
                  className={`${smallButton} disabled:opacity-40`}
                >
                  Delete…
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'pickedAll', ids: items.map((item) => item.id) })}
                  className="text-xs text-gray-500 hover:underline"
                >
                  Select all on this page
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'pickCleared' })}
                  disabled={!bar.anyPicked}
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
              {pages.range !== null ? (
                <nav aria-label="Pages" className="ml-auto flex items-center gap-2">
                  <span>{pages.range}</span>
                  {pages.pageLabel !== null ? (
                    <>
                      <button
                        type="button"
                        onClick={() => goTo(page.page - 1)}
                        disabled={pages.previousDisabled || isPending}
                        aria-label="Previous page"
                        className={pagerButton}
                      >
                        <Icon path={ICONS.chevronLeft} className="h-4 w-4" />
                      </button>
                      <span>{pages.pageLabel}</span>
                      <button
                        type="button"
                        onClick={() => goTo(page.page + 1)}
                        disabled={pages.nextDisabled || isPending}
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

      {state.dragging && uploads ? (
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
