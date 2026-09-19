// Published Claude API prices, US dollars per million tokens.
// Update these if Anthropic's pricing changes; costs already recorded on an
// answer are kept as they were computed, so history stays accurate.
const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;

export const knownModel = (model) => !!PRICES[model];

/** Dollar cost of one call's usage, or null if the model's price is unknown. */
export function costOf(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const input = (usage.input || 0) * p.input;
  const cached = (usage.cacheRead || 0) * p.input * CACHE_READ_MULTIPLIER;
  const output = (usage.output || 0) * p.output;
  return (input + cached + output) / 1e6;
}

export const addUsage = (a = {}, b = {}) => ({
  input: (a.input || 0) + (b.input || 0),
  output: (a.output || 0) + (b.output || 0),
  cacheRead: (a.cacheRead || 0) + (b.cacheRead || 0),
});
