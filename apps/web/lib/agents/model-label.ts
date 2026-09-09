/**
 * How a ledger row's model reads on a page: the model name as the
 * provider knows it, with the provider only when it adds something (an
 * OpenAI-dialect gateway can front anything, so "gpt-x · openai" says
 * which key paid for it). Rows from before the ledger recorded the model
 * (migration 098) have neither, and are named as such rather than
 * blanked — their spend is real, just not attributable to a model.
 */
export function modelLabel(provider: string | null, model: string | null): string {
  if (!model) return 'Model not recorded';
  if (!provider || provider === 'anthropic') return model;
  return `${model} · ${provider}`;
}
