/**
 * Mirth alert models, read for a person rather than dumped: which
 * channels an alert watches (whole, or some connectors of), what it sends
 * where, and — across every alert — which channels no enabled alert
 * watches at all. Pure: the tools in index.ts fetch, this file reads.
 *
 * Mirth's coverage rule (AlertChannels.isChannelEnabled): a channel named
 * in `enabledChannels` is watched; one in `partialChannels` is watched on
 * the connectors listed; one in `disabledChannels` is not; any other
 * channel — created after the alert was saved — is watched when the
 * alert's `newChannelSource`/`newChannelDestination` flags say new
 * channels are, the default on a fresh alert.
 */

import { isRecord, isString } from '@renkei/guards';
import { textOf } from '@renkei/connector-mirth';

export interface PartialChannel {
  channelId: string;
  /** metaDataIds (0 = source) the alert watches on this channel. */
  enabledConnectors: number[];
  disabledConnectors: number[];
}

export interface AlertAction {
  protocol: string;
  recipient: string;
}

export interface AlertActionGroup {
  subject: string;
  template: string;
  actions: AlertAction[];
}

export interface AlertSummary {
  id: string;
  name: string;
  enabled: boolean;
  newChannelSource: boolean;
  newChannelDestination: boolean;
  enabledChannels: string[];
  disabledChannels: string[];
  partialChannels: PartialChannel[];
  /** "ANY", or the error event types named. */
  errorEventTypes: string[];
  regex: string;
  actionGroups: AlertActionGroup[];
}

/**
 * The values inside an XStream collection as JSON writes it: a scalar
 * (`{"string": "id"}`), a list (`{"string": ["a","b"]}`), or several typed
 * keys at once (`{"int": [0,1], "null": null}` — a Java null element).
 */
function values(collection: unknown): unknown[] {
  if (Array.isArray(collection)) return collection;
  if (collection === null || collection === undefined) return [];
  if (!isRecord(collection)) return [collection];
  return Object.entries(collection).flatMap(([key, value]) =>
    key === 'null' ? [] : Array.isArray(value) ? value : [value]
  );
}

/** One element or a list of them (`"entry": {…}` vs `"entry": [{…}, {…}]`), as a list. */
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];

const strings = (collection: unknown): string[] =>
  values(collection).flatMap((value) => (isString(value) && value ? [value] : []));

const ints = (collection: unknown): number[] =>
  values(collection).flatMap((value) =>
    typeof value === 'number' ? [value] : /^\d+$/.test(textOf(value)) ? [Number(value)] : []
  );

const flag = (value: unknown): boolean => value === true || value === 'true';

/** One `<entry>` of partialChannels: the channel id and its connector lists. */
function partialOf(entry: unknown): PartialChannel | null {
  if (!isRecord(entry)) return null;
  const channelId = strings(entry.string)[0] ?? '';
  const connectors = isRecord(entry.alertConnectors) ? entry.alertConnectors : {};
  if (!channelId) return null;
  return {
    channelId,
    enabledConnectors: ints(connectors.enabledConnectors),
    disabledConnectors: ints(connectors.disabledConnectors),
  };
}

/** The alert models in a GET /alerts answer (`{"list": {"alertModel": [...]}}`), or one GET /alerts/{id}. */
export function alertModelsOf(body: unknown): AlertSummary[] {
  const root = isRecord(body) && isRecord(body.list) ? body.list : body;
  const models = isRecord(root) && 'alertModel' in root ? root.alertModel : root;
  const list = Array.isArray(models) ? models : models === undefined ? [] : [models];
  return list.flatMap((model) => {
    const summary = alertSummaryOf(model);
    return summary ? [summary] : [];
  });
}

/** One alert model as read from Mirth's JSON; null when it is not one. */
export function alertSummaryOf(model: unknown): AlertSummary | null {
  const root = isRecord(model) && isRecord(model.alertModel) ? model.alertModel : model;
  if (!isRecord(root) || !isString(root.id)) return null;
  const trigger = isRecord(root.trigger) ? root.trigger : {};
  const channels = isRecord(trigger.alertChannels) ? trigger.alertChannels : {};
  const partialEntries = isRecord(channels.partialChannels) ? channels.partialChannels.entry : [];
  const groups = isRecord(root.actionGroups) ? values(root.actionGroups) : [];
  return {
    id: root.id,
    name: textOf(root.name),
    enabled: flag(root.enabled),
    newChannelSource: flag(channels.newChannelSource),
    newChannelDestination: flag(channels.newChannelDestination),
    enabledChannels: strings(channels.enabledChannels),
    disabledChannels: strings(channels.disabledChannels),
    partialChannels: asList(partialEntries).flatMap((entry) => {
      const partial = partialOf(entry);
      return partial ? [partial] : [];
    }),
    errorEventTypes: strings(
      isRecord(trigger.errorEventTypes) ? trigger.errorEventTypes.errorEventType : undefined
    ),
    regex: textOf(trigger.regex),
    actionGroups: groups.flatMap((group) => {
      if (!isRecord(group)) return [];
      const actions = isRecord(group.actions) ? asList(group.actions.alertAction) : [];
      return [
        {
          subject: textOf(group.subject),
          template: textOf(group.template),
          actions: actions.flatMap((action) =>
            isRecord(action)
              ? [{ protocol: textOf(action.protocol), recipient: textOf(action.recipient) }]
              : []
          ),
        },
      ];
    }),
  };
}

export type Coverage =
  | { kind: 'whole' }
  | { kind: 'partial'; connectors: number[] }
  | { kind: 'new-channel' }
  | { kind: 'none' };

/** How one alert watches one channel, by Mirth's rule. */
export function coverageOf(alert: AlertSummary, channelId: string): Coverage {
  if (alert.enabledChannels.includes(channelId)) return { kind: 'whole' };
  const partial = alert.partialChannels.find((entry) => entry.channelId === channelId);
  if (partial) return { kind: 'partial', connectors: partial.enabledConnectors };
  if (alert.disabledChannels.includes(channelId)) return { kind: 'none' };
  return alert.newChannelSource || alert.newChannelDestination
    ? { kind: 'new-channel' }
    : { kind: 'none' };
}

/** True when some action of the alert sends to this channel (a "Channel" protocol action). */
export function sendsToChannel(alert: AlertSummary, channelId: string): boolean {
  return alert.actionGroups.some((group) =>
    group.actions.some(
      (action) => action.protocol.toLowerCase() === 'channel' && action.recipient === channelId
    )
  );
}

export interface ChannelCoverage {
  channelId: string;
  /** Each alert that watches the channel, and how. */
  watchedBy: { alert: AlertSummary; coverage: Exclude<Coverage, { kind: 'none' }> }[];
}

/** For every channel id given, the alerts (of those given) that watch it. */
export function channelCoverage(
  alerts: readonly AlertSummary[],
  channelIds: readonly string[]
): ChannelCoverage[] {
  return channelIds.map((channelId) => ({
    channelId,
    watchedBy: alerts.flatMap((alert) => {
      const coverage = coverageOf(alert, channelId);
      return coverage.kind === 'none' ? [] : [{ alert, coverage }];
    }),
  }));
}

/** What a coverage reads as, after a channel's name: "whole", "connectors 1, 2", "as a new channel". */
export function coverageLabel(coverage: Coverage): string {
  switch (coverage.kind) {
    case 'whole':
      return 'whole channel';
    case 'partial':
      return `connector${coverage.connectors.length === 1 ? '' : 's'} ${coverage.connectors.join(', ')}`;
    case 'new-channel':
      return 'as a new channel';
    case 'none':
      return 'not watched';
  }
}
