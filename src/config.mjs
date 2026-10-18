// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, noul, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags describe the
 * current model of each tier, and every one of those accepts adaptive thinking and `effort` —
 * including Haiku, as of Haiku 5.5. Capability is not uniform within a tier though, so what
 * `applyTier` actually checks is `supportsModernThinking` on the exact model id.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-5-5", family: "haiku", thinking: true, effort: true },
  { name: "sonnet", id: "claude-sonnet-5-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

/**
 * Models that take neither `thinking: {type:"adaptive"}` nor `output_config.effort`. Adaptive
 * thinking arrived with 4.6, so everything older (4.5 and below, plus the legacy `claude-3-*`
 * names) still wants `thinking.budget_tokens`, and `effort` errors on most of it. The account
 * catalogue can still offer an old model within a tier, so routing to one has to strip both.
 * Effort is stripped on Opus 4.5 too, which does accept it; losing that is harmless.
 */
const VERSIONED = /^claude-(?:haiku|sonnet|opus)-(\d+)(?:-(\d{1,2}))?(?!\d)/;

/** Whether an exact model id accepts adaptive thinking and `output_config.effort`. */
export const supportsModernThinking = (id) => {
  if (typeof id !== "string") return true;
  if (/^claude-[0-3]/.test(id)) return false; // claude-3-5-sonnet and friends
  const m = VERSIONED.exec(id);
  if (!m) return true; // unrecognised shape: assume current rather than strip fields
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major > 4 || (major === 4 && minor >= 6);
};

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "cj-auto";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
  /**
   * The status line suggests /clear or /compact when Jev is this sure a prompt starts a new
   * task, and only once the conversation is big enough for a reset to matter.
   */
  newTaskProbability: 0.8,
  newTaskMinContextTokens: 100000,
};

export const CONTEXT_WINDOW_TOKENS = 1000000;

/**
 * Auto-compact window seeded for the sentinel on first launch. Every request re-reads the
 * whole conversation, so context size dominates cost. Replaying two weeks of real sessions
 * at 5.5-generation prices: Claude Code's own ~967K threshold saved 1%, 600K saved 30%, 400K
 * 43%, 300K 49% and 200K 49%, while the number of compactions roughly doubled at each step
 * down. 400K takes most of the saving at a window twice the size of the long-standing 200K.
 * Change it per user with `/autocompact`, or per launch with `--autocompact`.
 */
export const DEFAULT_COMPACT_WINDOW = 400000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast",
      sonnet: "sonnet|balanced",
      opus: "opus|strong",
      fable: "fable|long",
    }[t.name]})\\b`,
    "i",
  ),
}));

// The work a request implies often lives in the conversation, not the prompt text.
const JUDGE_THE_WORK =
  "Judge the work the `request` will cause. When `conversation_before_request` is present, a short follow-up such as \"yes\", \"go ahead\", \"continue\" or \"try again\" carries the difficulty of the work it refers to.";

export const QUESTIONS = {
  task_complexity: score(
    [
      "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
      JUDGE_THE_WORK,
    ],
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    [
      "How much reasoning is required to complete the request correctly in one pass?",
      JUDGE_THE_WORK,
    ],
    COMPLEXITY_SCALE,
  ),
  new_task: noul(
    [
      "Does the `request` start a new, separate task that needs nothing from `conversation_before_request`?",
      "Answer no when the request refers to, continues, checks, or builds on any earlier request, reply, file, or result, even briefly.",
    ],
    {
      true: "Unrelated to the earlier conversation; clearing it would lose nothing this request needs.",
      false: "Refers to or builds on the earlier conversation, or there is no earlier conversation.",
    },
  ),
  tool_complexity: score(
    [
      "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
      JUDGE_THE_WORK,
    ],
    COMPLEXITY_SCALE,
  ),
};

/**
 * What each tier is for, phrased as kinds of coding work; facts about exact models live in
 * `MODEL_FACTS`. Jev reads literally, so each list names concrete cases rather than adjectives.
 */
const GUIDANCE = {
  haiku: {
    what: "Mechanical, factual, or fully specified work, where the answer or the exact change is already clear.",
    cost: "The cheapest tier, by a wide margin.",
    good_for: [
      "Answer a question about code, output, or files already shown in the conversation",
      "Run one obvious command (git status, the test suite, a build) and report the result",
      "Rename, reformat, add comments or docstrings, fix a typo, update a version number",
      "Make one small edit whose exact change the user spelled out",
      "Find where something is defined or used, list files, read a file and summarise it",
      "Write a commit message, stage and commit finished work, small config or text edits",
    ],
    not_for:
      "Choosing between designs, a bug whose cause is not yet known, changes that must stay consistent across several files, or anything security-sensitive.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    cost: "Mid-priced: well above the cheapest tier, below the strong tier.",
    good_for: [
      "Implement a feature, function, flag, or endpoint whose behaviour is specified",
      "Write or extend tests for existing behaviour",
      "Fix a bug whose cause is known or is local to one function or file",
      "Repeat an established pattern across several files, or follow an agreed plan step by step",
      "Refactor within one module, explain how code works, review a small diff",
      "Routine framework, API, CRUD, scripting, build, and shell work with clear steps",
    ],
    not_for:
      "Diagnosing a failure whose cause is unknown, architecture decisions, concurrency, security or auth, data migrations, or work where an earlier attempt in this conversation already failed.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    cost: "Expensive: above the mid tier.",
    good_for: [
      "Diagnose a failure whose cause is not known: intermittent, cross-component, environment or system level",
      "Design or change an architecture, data model, or interface used across modules",
      "Security, authentication, authorisation, permissions, cryptography, or payments",
      "Concurrency, race conditions, ordering, locking, or distributed-state bugs",
      "Database or schema migrations, data backfills, anything that risks data loss",
      "Performance investigations, large or risky refactors, reviewing a substantial change for correctness",
      "Planning work with ambiguous requirements, or a retry after an earlier attempt failed",
    ],
    not_for: "Routine work with a clear implementation that the mid tier can finish.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    cost: "The most expensive tier, billed as extra usage.",
    good_for: [
      "Whole-repository migrations or rewrites",
      "Multi-hour autonomous execution across many components",
      "Problems the strong tier has already failed at repeatedly in this conversation",
    ],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

/**
 * Facts about exact Claude models, keyed by API id; prices are per million input/output
 * tokens. Only ids listed here get a note, so an unknown model is described by its tier
 * alone. Update alongside `TIERS` when a new generation ships.
 */
const MODEL_FACTS = {
  "claude-haiku-5-5":
    "Claude Haiku 5.5, $0.10/$0.50. Fast, with adaptive thinking; capable on small, well-specified coding tasks.",
  "claude-sonnet-5-5":
    "Claude Sonnet 5.5, $2/$10. Strong everyday coding and agentic model.",
  "claude-opus-5-5":
    "Claude Opus 5.5, $4/$20. The strongest regular model, for hard reasoning, debugging, and design.",
  "claude-fable-5-1":
    "Claude Fable 5.1, $10/$50. The most capable model, for the longest and hardest work.",
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) => {
  const newest = new Map();
  for (const { id, tier } of models) if (tierOf(id) && !newest.has(tier)) newest.set(tier, id);
  return choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      JUDGE_THE_WORK,
      "Judge the reasoning the work requires, not how long or polite the message is or how long a reply it asks for.",
      "If `conversation_before_request` shows an earlier attempt at this work failed, choose a stronger model than a routine first attempt would need.",
      "Ignore the cost of switching models mid-conversation; the caller accounts for it separately.",
      "Treat different model versions as separate choices. Within one tier, an older version is weaker than the newest and no cheaper.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        {
          model: description ?? id,
          ...(MODEL_FACTS[id] && { facts: MODEL_FACTS[id] }),
          ...(newest.has(tier) && newest.get(tier) !== id && {
            version: `Older version in this tier; ${newest.get(tier)} is newer and stronger.`,
          }),
          ...GUIDANCE[tier],
        },
      ]),
    ),
  );
};

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
