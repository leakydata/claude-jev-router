import { TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, idOf, rankOf } from "./config.mjs";
import { ratesFor } from "./pricing.mjs";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Whether moving a conversation from tier `from` to the cheaper tier `to` pays for itself.
 * The first request on `to` writes whatever `to` does not already hold in its prompt cache,
 * where staying would mostly have read `from`'s cache; every later request then reads,
 * writes and generates at `to`'s lower prices. The move pays when the extra cost of that
 * first request is recovered within `switchHorizonRequests` requests.
 *
 * `cache.promptTokens` is the conversation's prompt size and `cache.warm[tier]` how much of
 * it each tier still holds cached. Without `cache`, `from` is assumed warm for the whole
 * `contextTokens` and `to` cold.
 */
export function switchPays(from, to, { contextTokens = 0, cache } = {}) {
  const size = cache?.promptTokens ?? contextTokens;
  const rf = ratesFor(idOf(from), size);
  const rt = ratesFor(idOf(to), size);
  if (!rf || !rt) return true;
  const warmFrom = Math.min(size, cache ? (cache.warm?.[from] ?? 0) : size);
  const warmTo = Math.min(size, cache?.warm?.[to] ?? 0);
  const first = (r, warm) => (size - warm) * r.write + warm * r.read;
  const extra = first(rt, warmTo) - first(rf, warmFrom);
  const perRequest =
    size * (rf.read - rt.read) +
    THRESHOLDS.typicalWriteTokens * (rf.write - rt.write) +
    THRESHOLDS.typicalOutputTokens * (rf.output - rt.output);
  return extra <= THRESHOLDS.switchHorizonRequests * perRequest;
}

/**
 * Jev's answer as a probability per tier that the tier is the cheapest one able to do the
 * work. An answer carrying only a choice and a confidence puts the confidence on the choice
 * and the rest on the more capable of the choice and the current tier, so doubt never moves
 * work to a weaker model.
 */
function tierProbabilities(jev, current) {
  const given = jev.tierProbabilities;
  if (given && Object.values(given).some((p) => p > 0)) return given;
  const confidence = jev.confidence ?? 0;
  const safer = rankOf(current) > rankOf(jev.choice) ? current : jev.choice;
  return { [jev.choice]: confidence, [safer]: (safer === jev.choice ? confidence : 0) + 1 - confidence };
}

/** Jev's probability that `tier` is enough: its own and every cheaper tier's share. */
function enoughAt(jev, current, tier) {
  const p = tierProbabilities(jev, current);
  return Math.min(1, TIER_NAMES.slice(0, rankOf(tier) + 1).reduce((sum, t) => sum + (p[t] ?? 0), 0));
}

/**
 * The cheapest tier Jev thinks is probably enough. Jev's choice question asks for the
 * cheapest model that can do the work, so the probability that a tier is enough is the sum
 * over it and every cheaper tier. Taking the cheapest tier where that sum reaches
 * `enoughProbability` (higher for Haiku) uses Jev's whole answer: a split between Haiku and Opus lands on Opus,
 * where the top choice alone would have said Haiku.
 */
function cheapestEnough(jev, current) {
  const p = tierProbabilities(jev, current);
  let sum = 0;
  for (const tier of TIER_NAMES) {
    sum += p[tier] ?? 0;
    const bar = tier === "haiku" ? THRESHOLDS.haikuEnoughProbability : THRESHOLDS.enoughProbability;
    if (sum >= bar - 1e-9) return tier;
  }
  return jev.choice;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number, tierProbabilities?: object}} input.jev
 *                                     null when Jev failed
 * @param {string} input.current       tier currently active in the conversation
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @param {object} [input.cache]       prompt size and per-tier cache state; see `switchPays`
 * @returns {{tier: string, reason: string, changed: boolean, enough?: number}} `enough` is
 *   Jev's probability that the tier routed to is enough, when Jev answered
 */
export function decide({ prompt, jev, current, available, contextTokens = 0, cache }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

  let target = cheapestEnough(jev, current);
  // A turn that fell short is retried a tier up: the router's misses are mostly work that
  // needed a stronger model than the prompt made it look, and the user's reply reveals them.
  // At the top regular tier there is nowhere to step up to, but the work stays there.
  if (jev.fellShort >= THRESHOLDS.stepUpProbability && rankOf(target) <= rankOf(current)) {
    const up = TIER_NAMES[rankOf(current) + 1];
    const floor = up && up !== "fable" ? up : current;
    return { ...settle(floor, "step-up-after-miss"), enough: enoughAt(jev, current, floor) };
  }
  const out =
    rankOf(target) < rankOf(current) && !switchPays(current, target, { contextTokens, cache })
      ? settle(current, "downgrade-not-worth-cache-rebuild")
      : settle(target, "jev");
  return { ...out, enough: enoughAt(jev, current, out.tier) };
}
