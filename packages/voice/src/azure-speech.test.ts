/**
 * The Azure contract, pinned without a network: the URLs for a region and
 * for a custom endpoint, the SSML a request becomes (speed included, text
 * escaped), the voice list's shape, and how each HTTP outcome maps onto the
 * error kinds the routes turn into messages. A vendor change that breaks
 * any of these breaks a person's voice mode silently otherwise.
 */

import {
  AzureSpeechProvider,
  azureEndpoints,
  buildSsml,
  parseAzureDetection,
  parseAzureVoice,
  prosodyRate,
} from './azure-speech';
import type { VoiceConfig } from './config';
import type { FetchLike } from './provider';

const config: VoiceConfig = {
  provider: 'azure-speech',
  region: 'eastus',
  endpoint: null,
  apiKey: 'secret-key',
  defaultVoice: 'en-US-AvaMultilingualNeural',
  defaultLocale: 'en-US',
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (!headers || Array.isArray(headers) || headers instanceof Headers) return undefined;
  return headers[name];
}

describe('azureEndpoints', () => {
  it('builds the regional hosts from the region', () => {
    expect(azureEndpoints({ region: 'westeurope', endpoint: null })).toEqual({
      voices: 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/voices/list',
      speech: 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1',
      transcribe:
        'https://westeurope.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1',
      detect:
        'https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
    });
  });

  it('routes every call under a custom endpoint when one is set', () => {
    const urls = azureEndpoints({
      region: 'eastus',
      endpoint: 'https://my-speech.cognitiveservices.azure.com/',
    });
    expect(urls.voices).toBe(
      'https://my-speech.cognitiveservices.azure.com/tts/cognitiveservices/voices/list'
    );
    expect(urls.speech).toBe(
      'https://my-speech.cognitiveservices.azure.com/tts/cognitiveservices/v1'
    );
    expect(urls.transcribe).toBe(
      'https://my-speech.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1'
    );
    expect(urls.detect).toBe(
      'https://my-speech.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15'
    );
  });
});

describe('parseAzureDetection', () => {
  it("joins the combined phrases and names the longest phrase's language", () => {
    expect(
      parseAzureDetection({
        durationMilliseconds: 3200,
        combinedPhrases: [{ channel: 0, text: ' Réserve la salle. ' }, { text: 'Merci.' }],
        phrases: [
          { text: 'Réserve la salle.', locale: 'fr-FR', durationMilliseconds: 2100 },
          { text: 'Merci.', locale: 'en-US', durationMilliseconds: 400 },
        ],
      })
    ).toEqual({ text: 'Réserve la salle. Merci.', locale: 'fr-FR' });
  });

  it('reads silence as empty text with no language', () => {
    expect(parseAzureDetection({ combinedPhrases: [{ text: '' }], phrases: [] })).toEqual({
      text: '',
      locale: null,
    });
  });

  it('rejects a body without combined phrases', () => {
    expect(parseAzureDetection({ phrases: [] })).toBeNull();
    expect(parseAzureDetection('nope')).toBeNull();
  });
});

describe('prosodyRate', () => {
  it.each([
    [1, '+0%'],
    [1.25, '+25%'],
    [0.8, '-20%'],
    [2, '+100%'],
    [0.5, '-50%'],
  ])('turns %s into %s', (rate, expected) => {
    expect(prosodyRate(rate)).toBe(expected);
  });

  it('clamps speeds outside the allowed range', () => {
    expect(prosodyRate(9)).toBe('+100%');
    expect(prosodyRate(0.1)).toBe('-50%');
    expect(prosodyRate(Number.NaN)).toBe('+0%');
  });
});

describe('buildSsml', () => {
  it('wraps the text in the voice and the pace, escaped', () => {
    const ssml = buildSsml(
      { text: 'Tom & Jerry <3 "quotes"', voice: 'en-GB-SoniaNeural', rate: 1.2, locale: 'en-GB' },
      'fallback'
    );
    expect(ssml).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB">' +
        '<voice name="en-GB-SoniaNeural"><prosody rate="+20%">' +
        'Tom &amp; Jerry &lt;3 &quot;quotes&quot;' +
        '</prosody></voice></speak>'
    );
  });

  it("uses the org's default voice when the request names none", () => {
    const ssml = buildSsml({ text: 'hi', voice: null, rate: 1, locale: 'en-US' }, 'en-US-Fallback');
    expect(ssml).toContain('<voice name="en-US-Fallback">');
  });
});

describe('parseAzureVoice', () => {
  it('keeps the short name as the id and builds a readable name', () => {
    expect(
      parseAzureVoice({
        Name: 'Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)',
        ShortName: 'en-US-JennyNeural',
        DisplayName: 'Jenny',
        LocalName: 'Jenny',
        Gender: 'Female',
        Locale: 'en-US',
      })
    ).toEqual({ id: 'en-US-JennyNeural', name: 'Jenny', locale: 'en-US', gender: 'female' });
  });

  it('adds the local name when it differs from the display name', () => {
    expect(
      parseAzureVoice({
        ShortName: 'ja-JP-NanamiNeural',
        DisplayName: 'Nanami',
        LocalName: '七海',
        Gender: 'Female',
        Locale: 'ja-JP',
      })?.name
    ).toBe('Nanami (七海)');
  });

  it('drops rows without a short name or locale, and unknown genders', () => {
    expect(parseAzureVoice({ DisplayName: 'x' })).toBeNull();
    expect(parseAzureVoice('nope')).toBeNull();
    expect(
      parseAzureVoice({ ShortName: 'en-US-X', Locale: 'en-US', Gender: 'Robot' })?.gender
    ).toBeNull();
  });
});

describe('AzureSpeechProvider', () => {
  it('lists voices with the key header and sorts them by locale then name', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json([
        { ShortName: 'en-US-Zed', DisplayName: 'Zed', Locale: 'en-US', Gender: 'Male' },
        { ShortName: 'de-DE-Katja', DisplayName: 'Katja', Locale: 'de-DE', Gender: 'Female' },
        { ShortName: 'en-US-Ava', DisplayName: 'Ava', Locale: 'en-US', Gender: 'Female' },
      ])
    );
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.listVoices();
    expect(result.ok && result.val.map((voice) => voice.id)).toEqual([
      'de-DE-Katja',
      'en-US-Ava',
      'en-US-Zed',
    ]);
    expect(calls[0].url).toBe(
      'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list'
    );
    expect(headerOf(calls[0].init, 'Ocp-Apim-Subscription-Key')).toBe('secret-key');
  });

  it('posts SSML for speech and streams the audio back', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
    );
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.synthesize({
      text: 'Hello there',
      voice: null,
      rate: 1,
      locale: 'en-US',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.contentType).toBe('audio/mpeg');
    const bytes = new Uint8Array(await new Response(result.val.body).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(headerOf(calls[0].init, 'Content-Type')).toBe('application/ssml+xml');
    expect(headerOf(calls[0].init, 'X-Microsoft-OutputFormat')).toBe(
      'audio-24khz-48kbitrate-mono-mp3'
    );
    expect(calls[0].init.body).toContain('<voice name="en-US-AvaMultilingualNeural">');
  });

  it('transcribes an utterance and reads the display text', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({ RecognitionStatus: 'Success', DisplayText: 'Book the room.' })
    );
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.transcribe({
      audio: new Uint8Array([0, 0]).buffer,
      contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
      locale: 'en-GB',
      detectLanguage: false,
    });
    expect(result).toEqual({ ok: true, val: { text: 'Book the room.', locale: 'en-GB' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-GB&format=simple'
    );
    expect(headerOf(calls[0].init, 'Content-Type')).toBe(
      'audio/wav; codecs=audio/pcm; samplerate=16000'
    );
  });

  it('treats silence as empty text, not as a failure', async () => {
    const { fetch } = fakeFetch(() => Response.json({ RecognitionStatus: 'NoMatch' }));
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.transcribe({
      audio: new ArrayBuffer(0),
      contentType: 'audio/wav',
      locale: 'en-US',
      detectLanguage: false,
    });
    expect(result).toEqual({ ok: true, val: { text: '', locale: 'en-US' } });
  });

  it('asks fast transcription which language was spoken when detecting', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({
        combinedPhrases: [{ text: 'Reserva la sala.' }],
        phrases: [{ text: 'Reserva la sala.', locale: 'es-ES', durationMilliseconds: 1500 }],
      })
    );
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.transcribe({
      audio: new Uint8Array([1, 2, 3]).buffer,
      contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
      locale: 'en-US',
      detectLanguage: true,
    });
    expect(result).toEqual({ ok: true, val: { text: 'Reserva la sala.', locale: 'es-ES' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15'
    );
    expect(headerOf(calls[0].init, 'Ocp-Apim-Subscription-Key')).toBe('secret-key');
    // The boundary is fetch's to set; a Content-Type here would drop it.
    expect(headerOf(calls[0].init, 'Content-Type')).toBeUndefined();
    const form = calls[0].init.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) return;
    // No locale named: the vendor picks from every language it knows.
    expect(JSON.parse(String(form.get('definition')))).toEqual({});
    const audio = form.get('audio');
    expect(audio).toBeInstanceOf(Blob);
    if (!(audio instanceof Blob)) return;
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it.each([404, 400])(
    'falls back to the named language when fast transcription answers %s',
    async (status) => {
      const { fetch, calls } = fakeFetch((url) =>
        url.includes('transcriptions:transcribe')
          ? new Response('no', { status })
          : Response.json({ RecognitionStatus: 'Success', DisplayText: 'Book the room.' })
      );
      const provider = new AzureSpeechProvider(config, fetch);
      const result = await provider.transcribe({
        audio: new ArrayBuffer(2),
        contentType: 'audio/wav',
        locale: 'en-GB',
        detectLanguage: true,
      });
      expect(result).toEqual({ ok: true, val: { text: 'Book the room.', locale: 'en-GB' } });
      expect(calls.map((call) => call.url)).toEqual([
        'https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
        'https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-GB&format=simple',
      ]);
    }
  );

  it('does not fall back on a failure the named language would share', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('nope', { status: 401 }));
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.transcribe({
      audio: new ArrayBuffer(2),
      contentType: 'audio/wav',
      locale: 'en-GB',
      detectLanguage: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('auth');
    expect(calls).toHaveLength(1);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [429, 'rate_limit'],
    [400, 'invalid_request'],
    [500, 'provider_error'],
  ])('maps a %s onto the %s error kind', async (status, kind) => {
    const { fetch } = fakeFetch(() => new Response('nope', { status }));
    const provider = new AzureSpeechProvider(config, fetch);
    const result = await provider.listVoices();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe(kind);
  });

  it('reports a network failure as such', async () => {
    const provider = new AzureSpeechProvider(config, async () => {
      throw new TypeError('fetch failed');
    });
    const result = await provider.synthesize({ text: 'x', voice: null, rate: 1, locale: 'en-US' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network');
  });
});
