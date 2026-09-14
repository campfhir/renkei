'use client';

/**
 * A unified diff, rendered: one fold per file with its +added −deleted,
 * the hunks inside. On a wide screen the old and new sides sit next to
 * each other (deletions paired with the additions that replaced them);
 * on a narrow one the lines stack in git's order. The context around a
 * hunk is whatever the diff carries — the caller asks the worker for
 * more or fewer lines.
 */

import { useMemo } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useMediaQuery } from '@/lib/use-media-query';
import {
  diffTotals,
  parseUnifiedDiff,
  sideBySideRows,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from '@/lib/code/diff';

const WIDE = '(min-width: 1024px)';

const cellBase =
  'px-2 py-0 align-top font-mono text-[11px] leading-5 whitespace-pre-wrap break-all';
const numberBase = 'w-10 shrink-0 select-none pr-2 text-right text-[10px] leading-5 text-gray-400';

function lineClass(line: DiffLine | null): string {
  if (!line) return 'bg-gray-50 dark:bg-gray-900/40';
  if (line.kind === 'add')
    return 'bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200';
  if (line.kind === 'del') return 'bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200';
  return '';
}

function mark(line: DiffLine | null): string {
  if (!line) return ' ';
  return line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
}

function statusWord(file: DiffFile): string | null {
  switch (file.status) {
    case 'added':
      return 'new';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return `renamed from ${file.oldPath ?? '?'}`;
    case 'binary':
      return 'binary';
    default:
      return null;
  }
}

export function Counts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="font-mono text-[11px] whitespace-nowrap">
      <span className="text-green-700 dark:text-green-400">+{added}</span>{' '}
      <span className="text-red-700 dark:text-red-400">−{deleted}</span>
    </span>
  );
}

function HunkStacked({ hunk }: { hunk: DiffHunk }) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        <tr>
          <td
            colSpan={3}
            className="bg-blue-50 px-2 py-0.5 font-mono text-[10px] text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
          >
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.heading}
          </td>
        </tr>
        {hunk.lines.map((line, index) => (
          <tr key={index} className={lineClass(line)}>
            <td className={numberBase}>{line.oldNo ?? ''}</td>
            <td className={numberBase}>{line.newNo ?? ''}</td>
            <td className={cellBase}>
              <span className="mr-1 inline-block w-2 select-none text-gray-400">{mark(line)}</span>
              {line.text}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HunkSideBySide({ hunk }: { hunk: DiffHunk }) {
  const rows = sideBySideRows(hunk);
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col className="w-10" />
        <col />
        <col className="w-10" />
        <col />
      </colgroup>
      <tbody>
        <tr>
          <td
            colSpan={4}
            className="bg-blue-50 px-2 py-0.5 font-mono text-[10px] text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
          >
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.heading}
          </td>
        </tr>
        {rows.map((row, index) => (
          <tr key={index}>
            <td className={`${numberBase} ${lineClass(row.left)}`}>{row.left?.oldNo ?? ''}</td>
            <td
              className={`${cellBase} border-r border-gray-200 dark:border-gray-800 ${lineClass(row.left)}`}
            >
              {row.left ? (
                <>
                  <span className="mr-1 inline-block w-2 select-none text-gray-400">
                    {mark(row.left)}
                  </span>
                  {row.left.text}
                </>
              ) : null}
            </td>
            <td className={`${numberBase} ${lineClass(row.right)}`}>{row.right?.newNo ?? ''}</td>
            <td className={`${cellBase} ${lineClass(row.right)}`}>
              {row.right ? (
                <>
                  <span className="mr-1 inline-block w-2 select-none text-gray-400">
                    {mark(row.right)}
                  </span>
                  {row.right.text}
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FileDiff({
  file,
  open,
  sideBySide,
}: {
  file: DiffFile;
  open: boolean;
  sideBySide: boolean;
}) {
  const status = statusWord(file);
  return (
    <details open={open} className="rounded-md border border-gray-200 dark:border-gray-800">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
        <Icon path={ICONS.chevron} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        {status ? <span className="text-[11px] text-gray-500">{status}</span> : null}
        <Counts added={file.added} deleted={file.deleted} />
      </summary>
      <div className="overflow-x-auto border-t border-gray-200 dark:border-gray-800">
        {file.status === 'binary' ? (
          <p className="px-2 py-1.5 text-xs text-gray-500">Binary file; no text diff.</p>
        ) : file.hunks.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-gray-500">No line changes.</p>
        ) : (
          file.hunks.map((hunk, index) =>
            sideBySide ? (
              <HunkSideBySide key={index} hunk={hunk} />
            ) : (
              <HunkStacked key={index} hunk={hunk} />
            )
          )
        )}
      </div>
    </details>
  );
}

/**
 * @param diff the unified diff text
 * @param openAll every file's fold starts open (a single file's diff in a
 *   tool result); otherwise only the first few do.
 */
export default function DiffView({
  diff,
  openAll = false,
  layout = 'auto',
}: {
  diff: string;
  openAll?: boolean;
  /** 'auto' picks side by side on a wide screen; the others force it. */
  layout?: 'auto' | 'split' | 'stacked';
}) {
  const wide = useMediaQuery(WIDE);
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const sideBySide = layout === 'split' || (layout === 'auto' && wide);
  if (files.length === 0) {
    return <p className="text-xs text-gray-500">No changes.</p>;
  }
  const totals = diffTotals(files);
  return (
    <div className="space-y-2">
      {files.length > 1 ? (
        <p className="text-xs text-gray-500">
          {files.length} files · <Counts added={totals.added} deleted={totals.deleted} />
        </p>
      ) : null}
      {files.map((file, index) => (
        <FileDiff
          key={`${file.path}-${index}`}
          file={file}
          open={openAll || index < 3}
          sideBySide={sideBySide}
        />
      ))}
    </div>
  );
}
