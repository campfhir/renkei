/**
 * The ADManager Plus card on the connectors page — where a person
 * connects each of the org's ADManager Plus servers (per domain, per
 * site…) with their OWN authtoken. This file owns only the static
 * header; the list below it (`AdManagerList`) is a client island, since
 * every row manages its own live connect/disconnect/permission state.
 */

import { ConnectorShell, ConnectorHeading } from './connector-shell';
import AdManagerList, { type ConnectableAdManagerInstanceView } from './admanager-list';

export type { ConnectableAdManagerInstanceView } from './admanager-list';

export default function AdManagerConnector({
  tenantId,
  instances,
}: {
  tenantId: string;
  instances: ConnectableAdManagerInstanceView[];
}) {
  return (
    <ConnectorShell anchor="card-admanager">
      <ConnectorHeading>ADManager Plus</ConnectorHeading>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Your organization&apos;s ManageEngine ADManager Plus servers. Connect each with your own
        technician authtoken — what you can reach there is what that token can. The permissions
        below are what your LLM&apos;s tools may attempt; ADManager Plus still has the final say.
      </p>

      <AdManagerList tenantId={tenantId} instances={instances} />
    </ConnectorShell>
  );
}
