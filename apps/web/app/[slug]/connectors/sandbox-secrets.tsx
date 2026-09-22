/**
 * The browser-secrets card on the connectors page — where a person hands
 * the sandbox browser a login it may TYPE on their behalf without the
 * model ever seeing it. This file owns only the card's outer chrome and
 * coach-mark anchor; `SandboxSecretsBody` (a client island) owns the
 * header row (title + "Add secret", since that button depends on live
 * state), the description, and the whole create/list/lock/unlock/revoke
 * surface below it.
 */

import { ConnectorShell } from './connector-shell';
import SandboxSecretsBody, { type SecretView } from './sandbox-secrets-body';

export type { SecretView } from './sandbox-secrets-body';

export default function SandboxSecrets({
  tenantId,
  secrets,
}: {
  tenantId: string;
  secrets: SecretView[];
}) {
  return (
    <ConnectorShell anchor="card-secrets">
      <SandboxSecretsBody tenantId={tenantId} secrets={secrets} />
    </ConnectorShell>
  );
}
