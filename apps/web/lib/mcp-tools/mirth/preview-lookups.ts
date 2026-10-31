/**
 * The names behind the ids a Mirth act's preview card carries (see
 * ../lookup.ts): the instance, channels, connectors, alerts, code templates,
 * users, resources and database tasks. Everything comes from the same
 * short-lived directory (resolve.ts) the tools resolve names with — one
 * cached listing per kind — so a card costs at most a listing per kind it
 * shows. Only reads; a failure leaves the name out and the card says "the
 * channel" rather than an id.
 *
 * An argument is an id or a name (every reference accepts either), so each
 * answer is keyed by the value as given.
 */

import type { ConnectedInstance } from '@renkei/connector-mirth';
import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, strings, text, type Args, type Names } from '../previews/card';
import { PREVIEW_BUILDERS } from '../previews';
import { REF_ARGS, resolveInstanceRef, type Directory, type RefKind } from './resolve';

export function registerMirthPreviewLookups(
  context: MCPToolContext,
  deps: {
    listConnected(): Promise<ConnectedInstance[] | string>;
    directory: Directory;
  }
): void {
  const lookup = async (args: Args): Promise<Names> => {
    const out: Record<string, string> = {};
    const connected = await deps.listConnected();
    if (typeof connected === 'string') return out;
    const instance = resolveInstanceRef(connected, args.instanceId);
    if (!instance.ok) return out;
    const raw = text(args.instanceId);
    const found = connected.find((entry) => entry.instance.id === instance.id);
    if (raw && found) out[nameKey('instance', raw)] = found.instance.name;

    const nameOf = async (kind: RefKind, ref: string, channelId?: string): Promise<void> => {
      const entries = await deps.directory.entries(instance.id, kind, { channelId });
      if (typeof entries === 'string') return;
      const folded = ref.toLowerCase();
      const hit =
        entries.find((entry) => entry.id === ref) ??
        entries.find((entry) => entry.name.toLowerCase() === folded);
      if (hit) out[nameKey(kind, ref)] = hit.name;
    };

    // The channel first: its id scopes the connector names.
    const channelRef = text(args.channelId);
    let channelId: string | undefined;
    if (channelRef) {
      await nameOf('channel', channelRef).catch(() => undefined);
      const entries = await deps.directory.entries(instance.id, 'channel');
      if (typeof entries !== 'string') {
        channelId = entries.find(
          (entry) =>
            entry.id === channelRef || entry.name.toLowerCase() === channelRef.toLowerCase()
        )?.id;
      }
    }

    const jobs: Promise<void>[] = [];
    for (const [arg, kind] of Object.entries(REF_ARGS)) {
      const value: unknown = args[arg];
      const refs = Array.isArray(value) ? strings(value) : text(value) ? [text(value)] : [];
      for (const ref of refs) {
        if (kind === 'connector') {
          if (channelId) jobs.push(nameOf(kind, ref, channelId).catch(() => undefined));
        } else if (arg !== 'channelId') {
          jobs.push(nameOf(kind, ref).catch(() => undefined));
        }
      }
    }
    await Promise.all(jobs);
    return out;
  };

  // The builders' own tool names: every Mirth act that has a generated card.
  const tools = Object.keys(PREVIEW_BUILDERS).filter((name) => name.startsWith('mirth_'));
  registerPreviewLookups(context, Object.fromEntries(tools.map((tool) => [tool, lookup])));
}
