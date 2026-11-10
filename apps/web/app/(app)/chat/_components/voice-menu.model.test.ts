/**
 * The composer's speaker menu (voice-menu.model.ts), as a person using it
 * would describe it. Choosing a language or voice there is
 * voice-picker.model.test.ts's; the browser specs keep the menu opening
 * over the chat, a reply read aloud and a sample heard.
 */

import {
  SPEEDS,
  deviceChoosers,
  deviceOptions,
  hearingChosen,
  speakerTitle,
} from './voice-menu.model';

const mic = { id: 'mic-1', label: 'Built-in microphone' };
const out = { id: 'out-1', label: 'Headphones' };

describe('the speaker button', () => {
  it('says a reply is being read, while it is', () => {
    expect(speakerTitle('speaking', false)).toBe('Reading the reply aloud');
    expect(speakerTitle('loading', true)).toBe('Reading the reply aloud');
  });

  it('says replies are read aloud when that is on, and just "Voice" otherwise', () => {
    expect(speakerTitle('idle', true)).toBe('Replies are read aloud');
    expect(speakerTitle('idle', false)).toBe('Voice');
  });
});

describe('speeds', () => {
  it('offers five, from three-quarters to double', () => {
    expect([...SPEEDS]).toEqual([0.75, 1, 1.25, 1.5, 2]);
  });
});

describe('devices', () => {
  it('keeps a chosen device that is not connected listed, so it can be dropped', () => {
    expect(deviceOptions([mic], 'mic-gone')).toEqual([
      mic,
      { id: 'mic-gone', label: 'Chosen device (not connected)' },
    ]);
    expect(deviceOptions([mic], 'mic-1')).toEqual([mic]);
    expect(deviceOptions([mic], null)).toEqual([mic]);
  });

  it('shows nothing until the devices are listed', () => {
    expect(
      deviceChoosers({ devices: null, microphone: null, audioOutput: null, canChooseOutput: true })
    ).toEqual({ microphone: false, output: false, unnamed: false });
  });

  it('shows a chooser for each kind with devices, the speaker only where the browser can switch it', () => {
    const devices = { microphones: [mic], outputs: [out] };
    expect(
      deviceChoosers({ devices, microphone: null, audioOutput: null, canChooseOutput: true })
    ).toEqual({ microphone: true, output: true, unnamed: false });
    expect(
      deviceChoosers({ devices, microphone: null, audioOutput: null, canChooseOutput: false })
    ).toMatchObject({ output: false });
  });

  it('before the microphone is allowed, says devices are named once it has been used', () => {
    const none = { microphones: [], outputs: [] };
    expect(
      deviceChoosers({ devices: none, microphone: null, audioOutput: null, canChooseOutput: true })
    ).toEqual({ microphone: false, output: false, unnamed: true });
    // A choice made earlier keeps its chooser.
    expect(
      deviceChoosers({
        devices: none,
        microphone: 'mic-1',
        audioOutput: null,
        canChooseOutput: true,
      })
    ).toMatchObject({ microphone: true });
  });
});

describe('Hear', () => {
  it('turns to Stop while the chosen voice’s sample plays, the default’s included', () => {
    expect(hearingChosen('en-GB-SoniaNeural', 'en-GB-SoniaNeural')).toBe(true);
    expect(hearingChosen('', null)).toBe(true);
    expect(hearingChosen('ja-JP-NanamiNeural', 'en-GB-SoniaNeural')).toBe(false);
    expect(hearingChosen(null, null)).toBe(false);
  });
});
