/**
 * The file-shares card on the connectors page — where a person connects an
 * org share with their OWN credentials, the same gesture as every OAuth
 * card. This file owns only the static header; the list below it
 * (`FileshareList`) is a client island, since every row manages its own
 * live connect/disconnect/exposure state.
 */

import { ConnectorShell, ConnectorHeading } from './connector-shell';
import FileshareList, { type ConnectableShareView } from './fileshare-list';

export type { ConnectableShareView } from './fileshare-list';

export default function FilesharesConnector({
  tenantId,
  shares,
}: {
  tenantId: string;
  shares: ConnectableShareView[];
}) {
  return (
    <ConnectorShell anchor="card-fileshares">
      <ConnectorHeading>File shares</ConnectorHeading>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Org network shares (SMB/SFTP). Connect each with your own file-server account — what you can
        reach there is what that account can. The checkboxes are what your LLM&apos;s tools may do;
        the servers still have the final say.
      </p>

      <FileshareList tenantId={tenantId} shares={shares} />
    </ConnectorShell>
  );
}
