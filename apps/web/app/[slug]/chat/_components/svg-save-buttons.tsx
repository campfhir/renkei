'use client';

/**
 * "Save as image" for an SVG the model wrote: a PNG (drawn by the browser)
 * or the .svg file itself. Used under a fenced ```svg block, on the inline
 * mockup card and in the fullscreen viewer, so an SVG can be kept — not
 * just copied as text.
 */

import { useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { saveSvg, type SvgSaveFormat } from '@/lib/svg-image';

type Status =
  | { kind: 'idle' }
  | { kind: 'saved'; format: SvgSaveFormat }
  | { kind: 'error'; message: string };

export default function SvgSaveButtons({
  source,
  name,
  className,
  buttonClassName,
}: {
  source: string;
  /** What the file is called, minus the extension — a title is turned into a safe name. */
  name: string;
  className?: string;
  buttonClassName: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const save = async (format: SvgSaveFormat) => {
    if (busy) return;
    setBusy(true);
    try {
      await saveSvg(source, name, format);
      setStatus({ kind: 'saved', format });
      window.setTimeout(() => setStatus({ kind: 'idle' }), 2000);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The image could not be saved.',
      });
    } finally {
      setBusy(false);
    }
  };

  const saved = (format: SvgSaveFormat) => status.kind === 'saved' && status.format === format;
  return (
    <span role="group" aria-label="Save as image" className={className}>
      {(['png', 'svg'] as const).map((format) => (
        <button
          key={format}
          type="button"
          disabled={busy}
          onClick={() => void save(format)}
          aria-label={`Save as ${format.toUpperCase()}`}
          title={`Save as ${format.toUpperCase()}`}
          className={buttonClassName}
        >
          <Icon path={saved(format) ? ICONS.check : ICONS.download} className="h-3.5 w-3.5" />
          {saved(format) ? 'Saved' : format.toUpperCase()}
        </button>
      ))}
      <span role="status" aria-live="polite" className="sr-only">
        {status.kind === 'saved' ? `Saved as ${status.format.toUpperCase()}` : ''}
      </span>
      {status.kind === 'error' ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {status.message}
        </span>
      ) : null}
    </span>
  );
}
