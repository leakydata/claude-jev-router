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
  /**
   * Routing picks the cheapest tier whose probability of being enough, by Jev's answer,
   * reaches this. Haiku has a higher bar because a Haiku miss costs the most quality, where
   * Sonnet doing work Opus would have done better costs little. Scored on 183 labelled
   * cases, 164 of them real turns graded by Opus (`npm run eval` prints the alternatives):
   * these two values cut misses to a weaker model from 66 to 31, only 5 of them to Haiku,
   * at about half the list price of running everything on Opus.
   */
  enoughProbability: 0.7,
  haikuEnoughProbability: 0.85,
  /**
   * A move to a cheaper model must recover the cost of rebuilding the prompt cache on it
   * within this many requests, about two turns of agentic work. Typical per-request cache
   * writes and output, from two weeks of transcripts, price the saving per request.
   */
  switchHorizonRequests: 20,
  typicalWriteTokens: 5000,
  typicalOutputTokens: 400,
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
  /**
   * Jev's certainty before suggesting that Claude hand a request to a sub-agent. Live checks
   * put gathering tasks at 0.63-0.91 and everything else at 0.05 or below.
   */
  delegateProbability: 0.6,
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
  "Judge the work the `request` will cause. When `conversation_before_request` is present, a short follow-up such as \"yes\", \"go ahead\", \"B\", \"continue\" or \"try again\" carries the difficulty of the work it refers to. A request that is a `<task-notification>` reports that a background task or sub-agent finished; the turn usually acts on its result, so judge the work that result leads to in the conversation, not the notification text.";

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
 * Whether a request is bulky gathering whose intermediate output the conversation will not
 * need. Asked by the prompt hook, which nudges Claude to delegate it to a sub-agent so only
 * the conclusion enters the main context, where it would otherwise be re-read on every later
 * request.
 */
export const DELEGATE_QUESTION = noul(
  [
    "Is the `request` a self-contained gathering task: completing it means searching, reading, scanning, or browsing a lot of material (many files, long logs, web pages, many emails or records), and afterwards only a short conclusion or list is needed?",
    "Answer no when the request asks for edits, design, or debugging that depends on details already in `conversation_before_request`, when it is a short question or a single command, or when it continues work the conversation is in the middle of.",
  ],
  {
    true: "Bulky, self-contained gathering whose raw material will not be needed again.",
    false: "Small, needs the conversation's context, or is part of ongoing work.",
  },
);

/**
 * What each tier is for, phrased as kinds of coding work; facts about exact models live in
 * `MODEL_FACTS`. Jev reads literally, so each list names concrete cases rather than adjectives.
 */
const GUIDANCE = {
  haiku: {
    what: "Work that needs no real thinking or combining of information: the answer or the exact change is already clear, and doing it is a lookup, one command, or a mechanical edit.",
    cost: "The cheapest tier, by a wide margin.",
    good_for: [
      "Answer a question from code, output, or files already shown in the conversation",
      "Run one obvious command (git status, the test suite, a build, a service status check) and report the result",
      "Acknowledge a finished background task or sub-agent when nothing more needs doing than reporting it",
      "Find where something is defined or used, list files, read one file or page and summarise it",
      "Rename, reformat, fix a typo, update a version number, or make one edit the user spelled out exactly",
      "Write a commit message, stage and commit finished work, answer a simple factual question",
    ],
    not_for:
      "Anything that needs several pieces of information combined, a choice between options, new logic written, a problem diagnosed, or several steps that depend on each other's results.",
  },
  sonnet: {
    what: "Most everyday engineering and system work. Claude Sonnet 5.5 is close to Opus 5.5 on most coding and agentic work, so it is the default for real work.",
    cost: "About half the strong tier's price on every kind of token.",
    good_for: [
      "Implement a feature, flag, endpoint, screen, or script whose behaviour is clear",
      "Fix a bug from a visible error message, failing test, log line, or stack trace",
      "Multi-file changes that follow a pattern or a plan already agreed in the conversation",
      "Write or extend tests, refactor, explain how code works, review a diff",
      "Build, packaging, deployment, configuration, and Linux administration with clear steps: install, configure, restart, fix a package with a clear error",
      "Research: read several files, docs, or web pages and combine them into an answer or a write-up",
      "Carry on with work the conversation is in the middle of, including acting on a finished sub-agent's result",
    ],
    not_for:
      "A failure whose cause is unknown and spans components or the system, subtle concurrency, security, or data-loss risk, architecture with many interacting constraints, long open-ended autonomous work, or a retry after an earlier attempt failed.",
  },
  opus: {
    what: "Only work where the mid tier would likely fall short: deep diagnosis, high-stakes correctness, or long open-ended autonomy.",
    cost: "About twice the mid tier's price on every kind of token.",
    good_for: [
      "Diagnose a failure whose cause is not known and spans components: intermittent, hardware, driver, kernel, network, or distributed",
      "Security, authentication, authorisation, permissions, cryptography, or payments",
      "Concurrency, race conditions, ordering, locking, or distributed-state bugs",
      "Database or schema migrations, data backfills, anything that risks losing data",
      "Design an architecture, data model, or interface used across modules or systems",
      "Long open-ended autonomous work: \"do everything\", plans spanning several systems, orchestrating many sub-agents with judgement calls on their results",
      "A retry after an earlier attempt in this conversation failed",
    ],
    not_for: "Clear work the mid tier can finish, even when it is long or touches several files.",
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
    "Claude Haiku 5.5, $0.10/$0.50, cache reads $0.01. Fast; reliable on lookups, single commands, and mechanical edits; weak at combining information or multi-step reasoning.",
  "claude-sonnet-5-5":
    "Claude Sonnet 5.5, $2/$10, cache reads $0.10. Strong everyday coding and agentic model, close to Opus 5.5 on most coding tasks.",
  "claude-opus-5-5":
    "Claude Opus 5.5, $4/$20, cache reads $0.20. The strongest regular model, for the hardest diagnosis, design, and long autonomous work.",
  "claude-fable-5-1":
    "Claude Fable 5.1, $10/$50, cache reads $0.25. The most capable model, for the longest and hardest work.",
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) => {
  const newest = new Map();
  for (const { id, tier } of models) if (tierOf(id) && !newest.has(tier)) newest.set(tier, id);
  return choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Most coding and system work is mid-tier work; choose the strong tier only when the work matches its good_for list, and the cheapest tier only when the work matches its good_for list.",
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
