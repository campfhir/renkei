import ConnectorIcon from '@/components/connector-icon';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import JiraConnector from './jira-connector';
import JsmConnector from './jsm-connector';
import ConfluenceConnector from './confluence-connector';
import BitbucketConnector from './bitbucket-connector';

/**
 * The Atlassian suite: Jira, Service Management, Confluence and Bitbucket,
 * grouped under one heading.
 *
 * Grouping only — and the difference from the Microsoft card matters enough
 * to state, because the two look alike and behave oppositely.
 *
 * Microsoft is ONE consent covering four products, so its card owns a single
 * connect/disconnect/re-authorize control and the products inside it own
 * nothing but their capabilities. Atlassian is FOUR separate OAuth apps with
 * four separate grants — the split is forced, not chosen: Atlassian enforces
 * scopes all-of and its consent URL has a length cliff, so the union of Jira,
 * JSM and Confluence scopes cannot fit on one app; Bitbucket is not even the
 * same OAuth system (consumers live on bitbucket.org). Each product here is
 * therefore genuinely its own connection, and keeps its own connect,
 * disconnect and approve controls, on the product they act on.
 *
 * A shared control at the foot of this card would be actively wrong: there is
 * no single Atlassian consent for it to perform, and someone could reasonably
 * read one "Disconnect Atlassian" button as covering all three when it could
 * only ever cover one.
 *
 * A server component: it holds no state, and every product below manages its
 * own.
 */
export default function AtlassianConnector({
  tenantId,
  jira,
  jsm,
  confluence,
  bitbucket,
}: {
  tenantId: string;
  /** Absent when the org has not enabled that product. */
  jira?: { ceiling: string[]; priorScopes: string[] | null };
  jsm?: {
    connected: boolean;
    displayName: string | null;
    ceiling: string[];
    priorScopes: string[] | null;
  };
  confluence?: {
    connected: boolean;
    displayName: string | null;
    ceiling: string[];
    priorScopes: string[] | null;
  };
  bitbucket?: {
    connected: boolean;
    displayName: string | null;
    ceiling: string[];
    priorScopes: string[] | null;
  };
}) {
  return (
    <ConnectorShell>
      <ConnectorHeading>
        <ConnectorIcon capabilityKey="atlassian" label="Atlassian" size={20} />
        Atlassian
      </ConnectorHeading>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Separate connections per product — Atlassian cannot fit the Jira, Service Management and
        Confluence scopes on a single consent, and Bitbucket has an OAuth system of its own. Connect
        each product you want; they are independent, and connecting one does not affect the others.
      </p>

      <div className="mt-3 space-y-3">
        {jira ? (
          <JiraConnector
            nested
            tenantId={tenantId}
            ceiling={jira.ceiling}
            priorScopes={jira.priorScopes}
          />
        ) : (
          <ConnectorShell nested>
            <ConnectorHeading nested>
              <ConnectorIcon capabilityKey="jira" label="Jira" size={20} />
              Jira
            </ConnectorHeading>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              Not enabled for this organization. An org admin can set it up under Connector setup.
            </p>
          </ConnectorShell>
        )}

        {jsm && (
          <JsmConnector
            nested
            tenantId={tenantId}
            connected={jsm.connected}
            displayName={jsm.displayName}
            ceiling={jsm.ceiling}
            priorScopes={jsm.priorScopes}
          />
        )}

        {confluence && (
          <ConfluenceConnector
            nested
            tenantId={tenantId}
            connected={confluence.connected}
            displayName={confluence.displayName}
            ceiling={confluence.ceiling}
            priorScopes={confluence.priorScopes}
          />
        )}

        {bitbucket && (
          <BitbucketConnector
            nested
            tenantId={tenantId}
            connected={bitbucket.connected}
            displayName={bitbucket.displayName}
            ceiling={bitbucket.ceiling}
            priorScopes={bitbucket.priorScopes}
          />
        )}
      </div>
    </ConnectorShell>
  );
}
