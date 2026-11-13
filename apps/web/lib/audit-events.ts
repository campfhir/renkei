/**
 * Recording platform actions to the tenant audit trail (migration 038).
 *
 * What belongs here: a person changing what the platform IS for them —
 * signing in or out, connecting or disconnecting a connector, creating,
 * changing or deleting an agent. What does not: using the platform. Tool
 * calls, searches and page views are usage, not audit, and adding them here
 * would drown the trail an operator actually reads.
 *
 * Recording is fire-and-forget, the same trade `usage-tracking.ts` makes: an
 * audit insert must never fail or slow the action it describes, so the write
 * is not awaited and a failure is logged rather than surfaced. The cost — a
 * lost row if the process dies mid-flight — is acceptable for a trail;
 * anything needing guaranteed capture belongs in the acting transaction.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export type AuditAction =
  | 'user.signed_in'
  | 'user.signed_out'
  /** An operator ended every session and MCP token of a person (details: subject, counts). */
  | 'user.sessions_revoked'
  /** A person downloaded their own data (details: format — zip or profile — and counts). */
  | 'user.data_exported'
  /**
   * A person's export was fetched ahead of a tap (the share sheet in a
   * home-screen app): it reached their device, and they may or may not have
   * kept it. A `user.data_exported` with `via: 'share-sheet'` follows when
   * they did (details: format and counts).
   */
  | 'user.data_export_prepared'
  /** A person imported chats or memories from another assistant (details: sources and counts). */
  | 'user.data_imported'
  | 'connector.connected'
  | 'connector.disconnected'
  | 'connector.audience_updated'
  /** An org-wide connector's credentials or settings were saved by an admin. */
  | 'connector.configured'
  | 'agent.created'
  | 'agent.updated'
  | 'agent.enabled'
  | 'agent.disabled'
  | 'agent.deleted'
  /** An operator halted runs from the org-wide queue (details: scope, status or runIds, outcome). */
  | 'agent.runs_halted'
  | 'agent.shared'
  | 'agent.unshared'
  | 'agent.access_granted'
  | 'agent.access_revoked'
  | 'agent.copied'
  | 'settings.updated'
  /** An operator saved an LLM model config (details: modelId, provider, model, baseUrl, keyReplaced). */
  | 'llm_model.configured'
  | 'llm_model.deleted'
  /** An operator pointed chat attachment storage somewhere (details: account, container, endpoint — never the key). */
  | 'storage.configured'
  | 'sandboxes.configured'
  /** An operator replaced the identity provider (details: issuer). */
  | 'oidc.provider_replaced'
  /** An operator changed the token limits: the weekly or monthly limit, the weekly reset, a model's limit (details: changed). */
  | 'token_limits.updated'
  /** An operator exempted a person from the token limits, or put them back under them (details: subject, exempt). */
  | 'token_limits.exemption_changed'
  /** An operator granted a person extra tokens for the week or month in progress (details: subject, period, tokens, expiresAt). */
  | 'token_limits.boost_granted'
  | 'token_limits.boost_revoked'
  /** A person allowed an MCP client to act as them (details: clientId, redirectTarget). */
  | 'oauth.consent_granted'
  /** A person refused an MCP client on the consent page (details: clientId, redirectTarget). */
  | 'oauth.consent_denied'
  /** A client registered itself through dynamic client registration (details: clientId, redirectUris). */
  | 'oauth.client_registered'
  | 'knowledge.reindex.started'
  | 'knowledge.reindex.paused'
  | 'knowledge.reindex.resumed'
  | 'sanitizer.script_saved'
  | 'sanitizer.script_deleted'
  | 'fileshare.created'
  | 'fileshare.updated'
  | 'fileshare.deleted'
  | 'fileshare.connected'
  | 'fileshare.disconnected'
  | 'mcp.server.created'
  | 'mcp.server.updated'
  | 'mcp.server.deleted'
  | 'mirth.instance.created'
  | 'mirth.instance.updated'
  | 'mirth.instance.deleted'
  /**
   * An admin saved an instance with transport security switched off —
   * certificate verification off and/or plaintext HTTP allowed (details:
   * modes, baseUrl, environment). Only a non-production instance on a
   * private host gets this far (lib/insecure-transport.ts); the event is
   * written on every save that keeps it on.
   */
  | 'mirth.instance.insecure_transport_enabled'
  | 'mirth.connected'
  | 'mirth.disconnected'
  | 'admanager.instance.created'
  | 'admanager.instance.updated'
  | 'admanager.instance.deleted'
  | 'admanager.instance.insecure_transport_enabled'
  | 'admanager.connected'
  | 'admanager.disconnected'
  /** The OnBase or OnBase Administration connector was saved with plaintext HTTP allowed (details: connector, modes, urls). */
  | 'onbase.insecure_transport_enabled'
  /**
   * A person's encryption key (docs/delegate-key-design.md): enrolled on
   * their first sign-in, replaced by rotation, their agents' delegation
   * revoked, another device approved to hold it.
   */
  | 'encryption-key.enrolled'
  | 'encryption-key.rotated'
  | 'encryption-key.automation-revoked'
  /** The automation delegations were replaced (a sign-in, a renewal, a window change). */
  | 'encryption-key.automation-renewed'
  | 'encryption-key.device-approved'
  | 'encryption-key.device-denied'
  | 'encryption-key.shredded'
  | 'sandbox.secret.created'
  | 'sandbox.secret.unlocked'
  | 'sandbox.secret.locked'
  | 'sandbox.secret.revoked'
  | 'code.project.created'
  | 'code.project.cloned'
  | 'code.project.deleted'
  | 'code.env.replaced'
  | 'code.env.deleted'
  /** A person asked for a larger checkout on a code project (details: requestedBytes). */
  | 'code.size_requested'
  /** An admin approved or denied that ask (details: decision, requestedBytes). */
  | 'code.size_request_decided'
  /** A repository's Pipelines switch or variables, changed from a code project's page. */
  | 'code.pipelines.enabled'
  | 'code.pipelines.disabled'
  /** A variable set replaced from its text box: which keys were added, changed, removed. */
  | 'code.pipelines.variables.replaced'
  /** A pipeline run started from a code project's Pipelines page. */
  | 'code.pipelines.run'
  /** A bitbucket-pipelines.yml committed from the page, from a template or edited. */
  | 'code.pipelines.file.committed'
  /** A GitHub repository's Actions switch, variables or workflow file, changed from a code project's page or its chat (details: keys, never values). */
  | 'code.actions.enabled'
  | 'code.actions.disabled'
  | 'code.actions.variables.replaced'
  | 'code.actions.file.committed'
  /** A service container started or stopped from a code project's Services page. */
  | 'code.services.started'
  | 'code.services.stopped'
  /** A preview (the project's own server, served through the app) started or stopped from a code project's routes. */
  | 'code.previews.started'
  | 'code.previews.stopped'
  | 'code.previews.opened'
  | 'code.files.uploaded'
  /** A file or folder of a checkout, or the whole checkout, downloaded as the person's offline copy. */
  | 'code.files.downloaded'
  /** A file saved from the code pane into the checkout, uncommitted. */
  | 'code.files.saved'
  /** An empty file created from the tree's "New file", uncommitted. */
  | 'code.files.created'
  /** An empty folder created from the tree's "New file" — a trailing "/". */
  | 'code.files.folder-created'
  /** A file or folder removed from the checkout's working tree. */
  | 'code.files.deleted'
  /** A file or folder renamed or moved within the checkout's working tree. */
  | 'code.files.renamed'
  /** A kernel started on the sandbox for a notebook, to run its cells from the code pane. */
  | 'code.notebook.run'
  | 'code.commit'
  | 'code.push'
  | 'code.branch_switch'
  /** Every uncommitted change on the checkout discarded (git reset --hard + clean -fd). */
  | 'code.discard_changes'
  /**
   * A Jira admin change request was applied from its review page — what
   * Renkei changed in Jira's configuration, and on whose click. Recorded
   * however it ended (details.status), since a partial apply changed Jira
   * too.
   */
  | 'jira_admin.change_applied'
  | 'salesforce_admin.change_applied';

export interface AuditEventInput {
  /** OIDC subject of who did it. */
  actorSubject: string | null;
  action: AuditAction;
  /** 'connector' | 'agent' — what kind of thing was acted on. */
  targetKind?: string;
  /** The thing itself: a grant provider key, an agent's name. */
  targetLabel?: string;
  /** Small structured extras (e.g. { byAdmin: true, subject }); never content. */
  details?: Record<string, unknown>;
}

export function recordAuditEvent(event: AuditEventInput): void {
  // Resolving the store or starting the write can throw synchronously (no
  // database configured); either way it is the same logged shrug.
  void Promise.resolve()
    .then(() =>
      getDataStore().auditEvents.record({
        id: randomUUID(),
        actorSubject: event.actorSubject,
        action: event.action,
        targetKind: event.targetKind ?? null,
        targetLabel: event.targetLabel?.slice(0, 200) ?? null,
        details: event.details ?? null,
      })
    )
    .catch(async (error: unknown) => {
      const actor = event.actorSubject ? await whoIs(event.actorSubject) : null;
      logger.warn(
        'the audit event {action}{byWhom}{onTarget} was not recorded; the audit trail is missing it: {error}',
        {
          component: 'audit',
          ...(actor ?? {}),
          byWhom: actor ? ` by ${actor.actor}` : '',
          action: event.action,
          onTarget: event.targetLabel
            ? ` on ${event.targetKind ?? 'the'} "${event.targetLabel}"`
            : '',
          ...(event.targetKind ? { targetKind: event.targetKind } : {}),
          ...(event.targetLabel ? { targetLabel: event.targetLabel } : {}),
          error: error instanceof Error ? error.message : String(error),
        }
      );
    });
}
