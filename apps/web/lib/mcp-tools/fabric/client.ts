/**
 * Microsoft Fabric access for the fabric_ tools, over the caller's own
 * delegated grant on the Fabric app registration — the THIRD Entra app
 * (lib/fabric-app.ts), on its own grant provider (FABRIC), so nothing here
 * reads the Microsoft 365 or Entra Developer grants.
 *
 * The entra-developer/client.ts pattern: access is resolved fresh on every
 * call, never captured in a handler closure, and no token is read here —
 * the delegate holds the grant and hands back a fetch that authenticates,
 * refreshes and retries once on a 401. The Fabric calls themselves are
 * @renkei/connector-fabric's (long-running operations, definition parts);
 * this module adds who is calling, logging, and the shaping helpers.
 */

import { FABRIC } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import {
  fabricApiBase,
  fabricGrantFetcher,
  fabricPages,
  fabricRequest,
  type FabricAnswer,
  type FabricFetch,
} from '@renkei/connector-fabric';
import { grantRefusalText } from '@/lib/grant-refusals';
import { logger } from '@/lib/logger';
import { callerAttrs, type CallerContext } from '../common';

const LABEL = 'Microsoft Fabric';

export interface FabricAccess {
  /** Fabric calls as the person; the delegate supplies the credential. */
  fetcher: FabricFetch;
  /** The API root (Fabric's own, or the browser suite's stand-in). */
  base: string;
  /** The Microsoft account whose grant this rides on (its oid). */
  accountId: string;
  /** The person's user principal name, for "connected as". */
  upn: string;
}

/** What the request wrapper needs of its caller — an MCPToolContext satisfies it. */
export interface FabricCallContext extends CallerContext {
  subject?: string;
  origin?: string;
}

/** The caller's Fabric grant as a fetcher; a string is why there is none. */
export async function resolveFabricAccess(
  context: FabricCallContext
): Promise<FabricAccess | string> {
  if (!context.subject) return 'No signed-in identity on this request.';
  const described = await delegateGrants().describe({ provider: FABRIC, subject: context.subject });
  if (!described.ok) {
    return described.err.type === 'NO_GRANT'
      ? 'Microsoft Fabric is not connected. Connect it on the Connectors page (it is separate ' +
          'from Microsoft 365), then try again.'
      : grantRefusalText(described.err.type, LABEL);
  }
  const { metadata } = described.val;
  return {
    fetcher: fabricGrantFetcher(context.subject, (tag) => grantRefusalText(tag, LABEL)),
    base: fabricApiBase(),
    accountId: described.val.accountId,
    upn: typeof metadata.upn === 'string' ? metadata.upn : '',
  };
}

/** One Fabric call, with a log line when Fabric (or Renkei) refuses it. */
export async function fabricCall(
  context: FabricCallContext,
  access: FabricAccess,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<FabricAnswer> {
  const answer = await fabricRequest(access.fetcher, access.base, method, path, body);
  if (!answer.ok) {
    logger.warn(
      "Microsoft Fabric refused {caller}'s {method} {path} ({code}); the tool reported it: {error}",
      {
        component: 'fabric/fetch',
        ...(await callerAttrs(context)),
        method,
        path,
        status: answer.status,
        code: answer.code,
        error: answer.error,
      }
    );
  }
  return answer;
}

/** Every record of a listing, following Fabric's continuation. */
export async function fabricList(
  context: FabricCallContext,
  access: FabricAccess,
  path: string,
  maxPages = 10
) {
  const listed = await fabricPages(access.fetcher, access.base, path, maxPages);
  if (!listed.ok) {
    logger.warn(
      "Microsoft Fabric refused {caller}'s listing of {path}; the tool reported it: {error}",
      {
        component: 'fabric/fetch',
        ...(await callerAttrs(context)),
        path,
        status: listed.status,
        error: listed.error,
      }
    );
  }
  return listed;
}

// ——— shaping ———

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value: string): boolean => GUID.test(value.trim());

/** The Fabric portal's page for a workspace, or an item in it. */
export function portalLink(workspaceId: string, item?: { type: string; id: string }): string {
  const base = `https://app.fabric.microsoft.com/groups/${encodeURIComponent(workspaceId)}`;
  if (!item) return base;
  const segment =
    item.type === 'Notebook'
      ? 'synapsenotebooks'
      : item.type === 'DataPipeline'
        ? 'pipelines'
        : item.type === 'Lakehouse'
          ? 'lakehouses'
          : null;
  return segment ? `${base}/${segment}/${encodeURIComponent(item.id)}` : base;
}
