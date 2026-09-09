import { modelLabel } from './model-label';

describe('modelLabel', () => {
  it('names the model alone for the default provider', () => {
    expect(modelLabel('anthropic', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('adds the provider when it is not the default', () => {
    expect(modelLabel('openai', 'gpt-5')).toBe('gpt-5 · openai');
  });

  it('says so for rows written before the model was recorded', () => {
    expect(modelLabel(null, null)).toBe('Model not recorded');
  });
});
