'use client';

/**
 * A generated picture at full size, in a window over the thread, with a
 * button to save it — the picture's counterpart to the mockup viewer and
 * its Save buttons. Portalled to <body> like the house modal, closes on
 * Escape, its button, or a click on the backdrop (there is nothing to pan
 * here, so a stray click beside the picture is safe to treat as "done").
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import DownloadLink from '@/components/download-link';

export default function ImagePreview({
  src,
  filename,
  onClose,
}: {
  src: string;
  filename: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Focus goes into the window and comes back to what opened it; the page stops scrolling.
  useEffect(() => {
    if (!mounted) return;
    const before = document.activeElement;
    rootRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (before instanceof HTMLElement) before.focus();
    };
  }, [mounted, onClose]);

  if (!mounted) return null;
  const button =
    'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800';
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image: ${filename}`}
      tabIndex={-1}
      data-testid="image-preview"
      className="fixed inset-0 z-50 flex flex-col bg-gray-100 outline-none dark:bg-gray-950"
    >
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-3 py-1.5 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={filename}>
          {filename}
        </h2>
        <DownloadLink
          href={src}
          filename={filename}
          prefetch
          className={button}
          data-testid="image-preview-download"
          aria-label="Download image"
        >
          <Icon path={ICONS.download} className="h-3.5 w-3.5" />
          Download
        </DownloadLink>
        <button type="button" onClick={onClose} aria-label="Close" className={button}>
          <Icon path={ICONS.close} className="h-4 w-4" />
        </button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img
          src={src}
          alt={filename}
          data-testid="image-preview-picture"
          className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
        />
      </div>
    </div>,
    document.body
  );
}
