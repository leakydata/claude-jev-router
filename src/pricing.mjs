// API list prices, used to put a dollar figure on token usage. A subscription is not billed
// this way, but the relative sizes are what matter when deciding where tokens go.

/**
 * $ per million tokens: [input, output, cache read]. Longest matching id prefix wins. Cache
 * reads are 0.1x input on most models, 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1
 * (platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-18).
 */
const PRICES = {
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1.0],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4": [1, 5, 0.1],
};
const IDS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

// Cache writes are priced from input: 1.25x for the 5-minute TTL, 2x for the 1-hour TTL.
const WRITE_5M = 1.25;
const WRITE_1H = 2;

// Haiku 5.5 charges five times its base rates for prompts over 100K tokens.
const LONG_PROMPT = { "claude-haiku-5-5": { over: 100000, factor: 5 } };

/** List prices for a model id, or null when it is not a priced Claude model. */
export function pricesFor(model) {
  const id = typeof model === "string" ? IDS.find((p) => model.startsWith(p)) : undefined;
  return id ? { id, rates: PRICES[id] } : null;
}

/**
 * Splits one API response's `usage` into token counts and dollars per component. Returns
 * null for a model with no known price.
 */
export function costOf(model, usage = {}) {
  const priced = pricesFor(model);
  if (!priced) return null;
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const long = LONG_PROMPT[priced.id];
  const factor = long && read + written + fresh > long.over ? long.factor : 1;
  const [input, out, cacheRead] = priced.rates.map((rate) => (rate * factor) / 1e6);
  const tokens = { cache_read: read, cache_write: written, input: fresh, output };
  const dollars = {
    cache_read: read * cacheRead,
    cache_write: (written - write1h) * input * WRITE_5M + write1h * input * WRITE_1H,
    input: fresh * input,
    output: output * out,
  };
  return { tokens, dollars, total: Object.values(dollars).reduce((a, b) => a + b, 0) };
}

/**
 * The advisor consultations inside one response, each priced at its own model. The response's
 * top-level usage covers only the executor; each consultation is an `advisor_message` entry
 * in `usage.iterations`.
 */
export function advisorCosts(usage = {}) {
  return (usage.iterations ?? [])
    .filter((i) => i?.type === "advisor_message" && i.model)
    .map((i) => ({ model: i.model, cost: costOf(i.model, i) }))
    .filter((a) => a.cost);
}

/**
 * $ per token for one request on `model` whose prompt is `promptTokens` long, or null for a
 * model with no known price. Cache writes are the 1-hour TTL Claude Code uses.
 */
export function ratesFor(model, promptTokens = 0) {
  const priced = pricesFor(model);
  if (!priced) return null;
  const long = LONG_PROMPT[priced.id];
  const factor = long && promptTokens > long.over ? long.factor : 1;
  const [input, output, read] = priced.rates.map((rate) => (rate * factor) / 1e6);
  return { input, output, read, write: input * WRITE_1H };
}
