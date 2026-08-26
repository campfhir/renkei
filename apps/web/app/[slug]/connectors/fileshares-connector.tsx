import React from 'react';
import Link from 'next/link';

/**
 * The file-shares card on the connectors page. Unlike every other card
 * there is nothing to connect: access is provisioned by an administrator
 * inside Renkei, so the card only reports which shares this person can
 * reach and at what level, and points at the files browser. It renders
 * only when at least one grant exists — an ungranted person sees no card,
 * the same rule the tools follow.
 */

export interface GrantedShareView {
  id: string;
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  defaultAccess: 'none' | 'read' | 'read_write';
  hasRules: boolean;
}

const ACCESS_LABEL: Record<GrantedShareView['defaultAccess'], string> = {
  none: 'specific folders',
  read: 'read',
  read_write: 'read/write',
};

export default function FilesharesConnector({
  slug,
  shares,
}: {
  slug: string;
  shares: GrantedShareView[];
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">File shares</h2>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            Org network shares (SMB/SFTP). Provisioned by your administrator — no account to
            connect.
          </p>
        </div>
        <Link
          href={`/${slug}/files`}
          className="shrink-0 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Browse
        </Link>
      </div>
      <ul className="mt-3 space-y-1.5">
        {shares.map((share) => (
          <li key={share.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              {share.name}
              <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                {share.protocol}://{share.host}
              </span>
            </span>
            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
              {ACCESS_LABEL[share.defaultAccess]}
              {share.hasRules ? ' · rules apply' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
