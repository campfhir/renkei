import { vttToText } from './vtt';

describe('vttToText', () => {
  const sample = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.500',
    'Ada Lovelace: Good morning, everyone.',
    '',
    '2',
    '00:00:04.800 --> 00:00:09.200',
    "Grace Hopper: Morning! Let's look at the deploy pipeline.",
    '',
    '3',
    '00:00:09.500 --> 00:00:12.000',
    'Ada Lovelace: The nightly job failed twice this week.',
    '',
  ].join('\n');

  it('keeps speaker-labeled cue text verbatim and drops all VTT scaffolding', () => {
    expect(vttToText(sample)).toBe(
      [
        'Ada Lovelace: Good morning, everyone.',
        "Grace Hopper: Morning! Let's look at the deploy pipeline.",
        'Ada Lovelace: The nightly job failed twice this week.',
      ].join('\n')
    );
  });

  it('handles CRLF line endings', () => {
    expect(vttToText(sample.replace(/\n/g, '\r\n'))).toContain('Grace Hopper: Morning!');
  });

  it('collapses runs of blank lines left by the header block', () => {
    const gappy = 'WEBVTT\n\n\n\n1\n00:00:00.000 --> 00:00:01.000\nSpeaker: Hi.\n\n\n';
    expect(vttToText(gappy)).toBe('Speaker: Hi.');
  });

  it('does not mistake utterances containing digits for cue numbers', () => {
    const vtt = 'WEBVTT\n\n12\n00:00:00.000 --> 00:00:01.000\nSpeaker: Route 66 is closed.\n';
    expect(vttToText(vtt)).toBe('Speaker: Route 66 is closed.');
  });

  it('returns an empty string for an empty or header-only file', () => {
    expect(vttToText('')).toBe('');
    expect(vttToText('WEBVTT\n\n')).toBe('');
  });
});
