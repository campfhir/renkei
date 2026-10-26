'use client';

/**
 * The progress of an upload from the Artifacts page: one bar for every
 * byte of every file, and the name of the file going up now. It stays up
 * until the last file is answered; the page is not left while it runs.
 */

import Modal from '@/components/modal';
import { sizeOf } from './artifact-bits';

export interface UploadTransfer {
  /** Files in this upload. */
  count: number;
  /** One-based: the file going up now. */
  index: number;
  name: string;
  /** Bytes sent so far, across every file. */
  loaded: number;
  /** Bytes in every file together. */
  bytes: number;
}

export default function ArtifactUploadModal({ transfer }: { transfer: UploadTransfer }) {
  const percent = transfer.bytes > 0 ? Math.min(100, (transfer.loaded / transfer.bytes) * 100) : 0;
  return (
    // Not dismissible: closing it would not stop the sends, only hide them.
    <Modal
      title={`Uploading ${transfer.count} ${transfer.count === 1 ? 'file' : 'files'}`}
      onClose={() => undefined}
      dismissible={false}
    >
      <div className="space-y-3 text-sm">
        <p className="truncate" title={transfer.name}>
          {transfer.count > 1 ? `${transfer.index} of ${transfer.count} · ` : ''}
          {transfer.name}
        </p>
        <div
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
        >
          <div className="h-full bg-blue-600 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-xs text-gray-500">
          {sizeOf(transfer.loaded)} of {sizeOf(transfer.bytes)} · {Math.round(percent)}%
        </p>
      </div>
    </Modal>
  );
}
