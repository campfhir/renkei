/**
 * How onbase_* and onbase_admin_* tools reach the customer's two Hyland
 * connectors — injected, not resolved inline, following the ZoomAuth/
 * GraphAuth shape with two departures worth stating:
 *
 *   - There is no requiredScopes parameter. Each Hyland IdP client exposes
 *     one opaque API scope, so per-tool scope gating would always pass or
 *     always fail — the availability probe (a grant row exists) is the
 *     whole gate.
 *   - No HTTP leaves this process for OnBase itself. Every request rides
 *     the delegate to the OnBase worker (the API server usually lives on a
 *     private network), so `api` wraps the worker's `api` op and `content`
 *     wraps its byte op.
 *
 * `onbase` (Document Management API) and `onbase-admin` (Administration
 * API) are separate Hyland OAuth clients with separate grants — mirroring
 * Jira/JSM/Confluence/Bitbucket as four separate Atlassian connectors
 * (connector-atlassian) rather than one. The logic below is identical
 * between them, so `connectorAuth()` builds it once per spec instead of
 * twice; only the grant provider (which is also the worker's `connector`
 * field) and the refusal prose differ.
 *
 * Tokens never reach this process (docs/delegate-key-design.md): a call
 * names the person by OIDC subject, and the delegate opens their grant,
 * refreshes it when due, retries once on a 401 (Hyland's session
 * lifecycle is undocumented, so a 401 is read as "token expired however
 * that happened"), and forwards the request to the worker with the token
 * attached. What the tools see of a dead grant is the delegate's verdict,
 * phrased here in the same words the resolvers used to say.
 */

import { ONBASE, ONBASE_ADMIN } from '@renkei/provider-grants';
import {
  obApi,
  obContent,
  onbaseClientFailure,
  type OnBaseClientError,
  type WireApiResponse,
  type WireContentResponse,
} from '@/lib/onbase/service-client';
import { grantRefusalText } from '@/lib/grant-refusals';
import type { MCPToolContext } from '../common';

export interface OnBaseApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  accept?: string;
}

export interface OnBaseAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /**
   * One API request via the worker, against this auth's own connector. A
   * string result is the user-visible refusal (the fileshare-auth idiom);
   * otherwise the envelope carries the upstream status and raw body text.
   */
  api(request: OnBaseApiRequest): Promise<WireApiResponse | string>;
  /** Rendition bytes via the worker, within the org's transfer cap. */
  content(path: string, accept?: string): Promise<WireContentResponse | string>;
}

/** What distinguishes the two connectors; everything else below is shared. */
interface OnBaseConnectorSpec {
  /** provider_grants.provider AND the worker's `connector` field — same string. */
  connector: string;
  /** For refusal prose: "OnBase" or "OnBase Administration". */
  label: string;
}

/** The tags the delegate answers about the grant itself, not about the OnBase call. */
const GRANT_VERDICTS: readonly string[] = [
  'NO_GRANT',
  'GRANT_UNREADABLE',
  'GRANT_REVOKED',
  'REFRESH_FAILED',
  'NOT_CONFIGURED',
];

/** Whether a client failure is the delegate refusing the grant rather than OnBase answering. */
export function isOnBaseGrantRefusal(error: OnBaseClientError): boolean {
  return error.kind === 'op' && GRANT_VERDICTS.includes(error.type);
}

/**
 * A client failure as the sentence the tools show: the delegate's grant
 * verdicts in the resolvers' old words, anything else as the worker said it.
 */
export function onbaseFailureText(error: OnBaseClientError, label: string): string {
  if (isOnBaseGrantRefusal(error) && error.kind === 'op') {
    return grantRefusalText(error.type, label);
  }
  return onbaseClientFailure(error).message;
}

const NO_SUBJECT = 'No signed-in subject on this MCP session.';

function makeOauthAuth(spec: OnBaseConnectorSpec) {
  return function oauthAuth(context: MCPToolContext): OnBaseAuth {
    return {
      kind: 'oauth',
      async api(request) {
        if (!context.subject) return NO_SUBJECT;
        const result = await obApi({
          tenantId: context.tenantId,
          connector: spec.connector,
          subject: context.subject,
          method: request.method,
          path: request.path,
          ...(request.query ? { query: request.query } : {}),
          ...(request.body !== undefined ? { body: request.body } : {}),
          ...(request.accept ? { accept: request.accept } : {}),
        });
        return result.ok ? result.val : onbaseFailureText(result.err, spec.label);
      },
      async content(path, accept) {
        if (!context.subject) return NO_SUBJECT;
        const result = await obContent({
          tenantId: context.tenantId,
          connector: spec.connector,
          subject: context.subject,
          path,
          ...(accept ? { accept } : {}),
        });
        return result.ok ? result.val : onbaseFailureText(result.err, spec.label);
      },
    };
  };
}

/**
 * The other implementation, for when no OnBase instance exists to run the
 * oauth one against for real. See webex-auth.ts's `deniedWebexAuth` for the
 * full reasoning — identical here.
 */
function makeDeniedAuth(spec: OnBaseConnectorSpec) {
  return function deniedAuth(): OnBaseAuth {
    const refusal =
      `No ${spec.label} test credential is configured for this connector yet — this call is ` +
      'always denied, on purpose, to prove the tools handle that instead of crashing.';
    return {
      kind: 'denied',
      api: () => Promise.resolve(refusal),
      content: () => Promise.resolve(refusal),
    };
  };
}

/* ---------------------------- Document API ---------------------------- */

export const ONBASE_LABEL = 'OnBase';

const DOCUMENT_SPEC: OnBaseConnectorSpec = { connector: ONBASE, label: ONBASE_LABEL };

export const oauthOnbaseAuth = makeOauthAuth(DOCUMENT_SPEC);
export const deniedOnbaseAuth = makeDeniedAuth(DOCUMENT_SPEC);

/* -------------------------- Administration API -------------------------- */

const ADMIN_SPEC: OnBaseConnectorSpec = { connector: ONBASE_ADMIN, label: 'OnBase Administration' };

export const oauthOnbaseAdminAuth = makeOauthAuth(ADMIN_SPEC);
export const deniedOnbaseAdminAuth = makeDeniedAuth(ADMIN_SPEC);
