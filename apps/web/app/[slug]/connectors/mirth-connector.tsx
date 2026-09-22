/**
 * The Mirth Connect card on the connectors page — where a person connects
 * each of the org's Mirth servers (dev, test, prod…) with their OWN Mirth
 * account. This file owns only the static header; the list below it
 * (`MirthList`) is a client island, since every row manages its own live
 * connect/disconnect/permission state.
 */

import { ConnectorShell, ConnectorHeading } from './connector-shell';
import MirthList, { type ConnectableMirthInstanceView } from './mirth-list';

export type { ConnectableMirthInstanceView } from './mirth-list';

export default function MirthConnector({
  tenantId,
  instances,
}: {
  tenantId: string;
  instances: ConnectableMirthInstanceView[];
}) {
  return (
    <ConnectorShell anchor="card-mirth">
      <ConnectorHeading>Mirth Connect</ConnectorHeading>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Your organization&apos;s Mirth Connect servers. Connect each with your own Mirth account —
        what you can reach there is what that account can. The permissions are what your LLM&apos;s
        tools may do on that server; Mirth still has the final say.
      </p>

      <MirthList tenantId={tenantId} instances={instances} />
    </ConnectorShell>
  );
}
