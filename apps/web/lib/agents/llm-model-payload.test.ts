import { parseModelPayload } from './llm-model-payload';

const base = { label: 'Prod', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' };

describe('parseModelPayload — data handling', () => {
  it('stores nothing when the operator said nothing, so the row reads as unknown / not covered', () => {
    const parsed = parseModelPayload(base);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.settings).toEqual({});
  });

  it('keeps the four fields, trimmed and bounded, and only a known retention word', () => {
    const parsed = parseModelPayload({
      ...base,
      dataResidency: '  Azure East US, DataZone ',
      providerRetention: 'abuse-monitoring',
      baaCovered: true,
      notes: ' BAA signed 2026-01 ',
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.settings).toEqual({
      dataResidency: 'Azure East US, DataZone',
      providerRetention: 'abuse-monitoring',
      baaCovered: true,
      notes: 'BAA signed 2026-01',
    });

    const loose = parseModelPayload({
      ...base,
      providerRetention: 'forever',
      baaCovered: 'yes',
      notes: '',
    });
    if ('error' in loose) throw new Error(loose.error);
    expect(loose.settings).toEqual({});
  });

  it("drops an explicit 'unknown' retention: absence already means that, and the badge reads either", () => {
    const parsed = parseModelPayload({ ...base, providerRetention: 'unknown', baaCovered: false });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.settings).toEqual({});
  });
});

describe('parseModelPayload — context window', () => {
  it('keeps a positive window as a whole number of tokens', () => {
    const parsed = parseModelPayload({ ...base, contextWindow: 200000.9 });
    expect('error' in parsed ? null : parsed.settings.contextWindow).toBe(200000);
  });

  it('stores nothing for a blank, zero, negative or non-numeric window', () => {
    for (const contextWindow of [0, -5, '200000', null]) {
      const parsed = parseModelPayload({ ...base, contextWindow });
      expect('error' in parsed ? null : parsed.settings.contextWindow).toBeUndefined();
    }
  });
});
