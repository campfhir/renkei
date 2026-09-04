'use client';

/**
 * One file the assistant produced: save it to this device, or copy it to
 * a network share the person has connected (written with their own
 * credentials). The working copy in the org's store stays where it is.
 * OneDrive and SharePoint need a folder picker before they can join the
 * list; the share path is a typed folder for now.
 */

import { useEffect, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { AttachmentView } from '@/lib/chat/views';

interface Share {
  id: string;
  name: string;
  host: string;
  shareName: string;
  connected: boolean;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArtifactModal({
  tenantId,
  artifact,
  onClose,
}: {
  tenantId: string;
  artifact: AttachmentView;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [shareId, setShareId] = useState('');
  const [path, setPath] = useState('/');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void chatClient.shares(tenantId).then((result) => {
      if (cancelled) return;
      const list = (result.data?.shares ?? []).map((share) => ({
        id: share.id,
        name: share.name,
        host: share.host,
        shareName: share.shareName,
        connected: share.connection !== null,
      }));
      setShares(list);
      const first = list.find((share) => share.connected);
      if (first) setShareId(first.id);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const connected = (shares ?? []).filter((share) => share.connected);
  const copy = async () => {
    if (!shareId) return;
    setBusy(true);
    setOutcome(null);
    const result = await chatClient.copyAttachment(tenantId, artifact.id, {
      kind: 'fileshare-file',
      shareId,
      path,
    });
    setBusy(false);
    setOutcome(
      result.data ?? { ok: false, detail: result.error ?? 'The copy could not be started.' }
    );
  };

  return (
    <Modal title={artifact.filename} onClose={onClose}>
      <p className="mb-4 text-xs text-gray-500">
        {sizeOf(artifact.sizeBytes)} · {artifact.contentType}
      </p>
      <div className="space-y-4">
        <section>
          <h3 className="mb-1 text-sm font-medium">This device</h3>
          <a
            href={`/api/tenant/${tenantId}/chat/attachments/${artifact.id}`}
            download={artifact.filename}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Icon path={ICONS.download} className="h-4 w-4" />
            Download
          </a>
        </section>
        <section>
          <h3 className="mb-1 text-sm font-medium">A network share</h3>
          {shares === null ? (
            <p className="text-xs text-gray-500">Looking up your shares…</p>
          ) : connected.length === 0 ? (
            <p className="text-xs text-gray-500">
              You have no connected file shares. Connect one under Files to copy there.
            </p>
          ) : (
            <div className="space-y-2">
              <select
                value={shareId}
                onChange={(event) => setShareId(event.target.value)}
                aria-label="Share"
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {connected.map((share) => (
                  <option key={share.id} value={share.id}>
                    {share.name} ({share.host}/{share.shareName})
                  </option>
                ))}
              </select>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                aria-label="Folder on the share"
                placeholder="/"
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
              <button
                type="button"
                onClick={() => void copy()}
                disabled={busy || !shareId}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.copy} className="h-4 w-4" />
                {busy ? 'Copying…' : 'Copy to the share'}
              </button>
            </div>
          )}
          {outcome ? (
            <p
              className={`mt-2 text-xs ${outcome.ok ? 'text-green-700 dark:text-green-300' : 'text-red-600 dark:text-red-400'}`}
            >
              {outcome.detail}
            </p>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}
