/**
 * Reading Mirth alert models: the XStream JSON shapes an alert's channel
 * lists take (one id, many, a Java null among the ints), Mirth's coverage
 * rule for channels an alert names and ones it never saw, and the
 * cross-alert coverage the tools report.
 */

import {
  alertModelsOf,
  alertSummaryOf,
  channelCoverage,
  coverageLabel,
  coverageOf,
  sendsToChannel,
} from './alerts';

const COLLECTOR = 'dc345de0-10f3-4f8d-a831-3211d569acfc';

const model = (overrides: Record<string, unknown> = {}) => ({
  '@version': '4.5.2',
  id: 'a1',
  name: 'P1 Lab',
  enabled: true,
  trigger: {
    '@class': 'defaultTrigger',
    alertChannels: {
      newChannelSource: false,
      newChannelDestination: false,
      enabledChannels: { string: ['c1', 'c2'] },
      disabledChannels: null,
      partialChannels: {
        entry: {
          string: 'c3',
          alertConnectors: {
            enabledConnectors: { int: 2 },
            disabledConnectors: { int: [0, 1], null: null },
          },
        },
      },
    },
    errorEventTypes: { errorEventType: 'ANY' },
    regex: null,
  },
  actionGroups: {
    alertActionGroup: {
      actions: { alertAction: { protocol: 'Channel', recipient: COLLECTOR } },
      subject: 'Lab error',
      template: 'channel: ${channelName}',
    },
  },
  ...overrides,
});

describe('alertSummaryOf', () => {
  it('reads one id, a list of ids, and a partial entry with a null among its ints', () => {
    const alert = alertSummaryOf(model())!;
    expect(alert).toMatchObject({
      id: 'a1',
      name: 'P1 Lab',
      enabled: true,
      enabledChannels: ['c1', 'c2'],
      disabledChannels: [],
      partialChannels: [{ channelId: 'c3', enabledConnectors: [2], disabledConnectors: [0, 1] }],
      errorEventTypes: ['ANY'],
      regex: '',
    });
    expect(alert.actionGroups).toEqual([
      {
        subject: 'Lab error',
        template: 'channel: ${channelName}',
        actions: [{ protocol: 'Channel', recipient: COLLECTOR }],
      },
    ]);
  });

  it('reads several actions and the string form of booleans', () => {
    const alert = alertSummaryOf(
      model({
        enabled: 'false',
        actionGroups: {
          alertActionGroup: {
            actions: {
              alertAction: [
                { protocol: 'Email', recipient: 'a@example.org' },
                { protocol: 'Email', recipient: 'b@example.org' },
              ],
            },
            template: 't',
          },
        },
      })
    )!;
    expect(alert.enabled).toBe(false);
    expect(alert.actionGroups[0].actions.map((a) => a.recipient)).toEqual([
      'a@example.org',
      'b@example.org',
    ]);
    expect(alert.actionGroups[0].subject).toBe('');
  });

  it('refuses what is not an alert model', () => {
    expect(alertSummaryOf(null)).toBeNull();
    expect(alertSummaryOf({ name: 'no id' })).toBeNull();
  });

  it('unwraps a GET /alerts list, a single-alert list and a GET /alerts/{id} body', () => {
    expect(alertModelsOf({ list: { alertModel: [model(), model({ id: 'a2' })] } })).toHaveLength(2);
    expect(alertModelsOf({ list: { alertModel: model() } })).toHaveLength(1);
    expect(alertModelsOf({ alertModel: model() })).toHaveLength(1);
    expect(alertModelsOf({ list: '' })).toEqual([]);
  });
});

describe('coverageOf', () => {
  const alert = alertSummaryOf(model())!;

  it('watches the enabled channels whole, the partial ones on their connectors, no others', () => {
    expect(coverageOf(alert, 'c1')).toEqual({ kind: 'whole' });
    expect(coverageOf(alert, 'c3')).toEqual({ kind: 'partial', connectors: [2] });
    expect(coverageOf(alert, 'c9')).toEqual({ kind: 'none' });
  });

  it('watches a channel it never saw only when new channels are on, and never a disabled one', () => {
    const catchAll = alertSummaryOf(
      model({
        trigger: {
          alertChannels: {
            newChannelSource: true,
            newChannelDestination: true,
            enabledChannels: null,
            disabledChannels: { string: 'c1' },
            partialChannels: null,
          },
          errorEventTypes: { errorEventType: 'ANY' },
        },
      })
    )!;
    expect(coverageOf(catchAll, 'c9')).toEqual({ kind: 'new-channel' });
    expect(coverageOf(catchAll, 'c1')).toEqual({ kind: 'none' });
  });

  it('labels each kind for a person', () => {
    expect(coverageLabel({ kind: 'whole' })).toBe('whole channel');
    expect(coverageLabel({ kind: 'partial', connectors: [1, 2] })).toBe('connectors 1, 2');
    expect(coverageLabel({ kind: 'partial', connectors: [4] })).toBe('connector 4');
    expect(coverageLabel({ kind: 'new-channel' })).toBe('as a new channel');
  });
});

describe('sendsToChannel', () => {
  it('is true for a Channel action aimed at the channel, false for email or another channel', () => {
    const alert = alertSummaryOf(model())!;
    expect(sendsToChannel(alert, COLLECTOR)).toBe(true);
    expect(sendsToChannel(alert, 'c1')).toBe(false);
  });
});

describe('channelCoverage', () => {
  it('names, per channel, every alert that watches it and how', () => {
    const lab = alertSummaryOf(model())!;
    const rad = alertSummaryOf(
      model({
        id: 'a2',
        name: 'P1 Radiology',
        trigger: {
          alertChannels: { enabledChannels: { string: 'c3' } },
          errorEventTypes: { errorEventType: 'ANY' },
        },
      })
    )!;
    const coverage = channelCoverage([lab, rad], ['c1', 'c3', 'c9']);
    expect(
      coverage.map((c) => c.watchedBy.map((w) => `${w.alert.name}:${w.coverage.kind}`))
    ).toEqual([['P1 Lab:whole'], ['P1 Lab:partial', 'P1 Radiology:whole'], []]);
  });
});
