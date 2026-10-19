// Checks whether routing costs quality, from real turns in Claude Code's transcripts:
// `scan` has Jev read each turn's next prompt for signs the turn fell short, and `judge` has
// Opus grade sampled turns and name the cheapest model that would have done each one. The
// judge's labels feed `npm run eval`. Everything is written under ~/.cache/claude-jev, never
// the repository: these are the user's own prompts.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { transcriptFiles } from "./report.mjs";
import { clip, mainModel, readTurns } from "./turns.mjs";
import { recentContext } from "./proxy.mjs";
import { tierOf } from "./config.mjs";

export const QUALITY_DIR = join(homedir(), ".cache", "claude-jev", "quality");
export const SCAN_FILE = join(QUALITY_DIR, "scan.json");
export const JUDGED_FILE = join(homedir(), ".cache", "claude-jev", "eval", "judged.jsonl");

const privateDir = (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 });

/** Main-conversation turns with at least one reply, from the last `days` days. */
export function collectTurns(days) {
  const since = Date.now() - days * 86400000;
  const turns = [];
  for (const file of transcriptFiles(undefined, since)) {
    if (/[\\/]subagents[\\/]/.test(file)) continue;
    for (const turn of readTurns(file)) if (turn.at >= since && turn.requests) turns.push(turn);
  }
  return turns;
}

const FELL_SHORT = noul(
  [
    "Does `next_message` show that the assistant's turn fell short: the user says it is wrong, did not work, or missed the point, corrects it, repeats or rephrases the same request, or asks for it to be redone?",
    "Answer no when the next message approves, moves on, asks something new, adds a new requirement, or continues the work.",
  ],
  {
    true: "The turn fell short and the user had to correct or repeat it.",
    false: "The user moved on, approved, or continued; nothing suggests the turn failed.",
  },
);

let jev;
const jevClient = () =>
  (jev ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: 20000,
    retry: { maxRetries: 2 },
    logLevel: "warn",
  }));

/** Jev's probability that a turn fell short, judged from the user's next prompt. */
async function fellShort(turn) {
  const result = await jevClient().systemOne({
    state: {
      request: clip(turn.prompt, 3000),
      assistant_reply: clip(turn.reply, 3000),
      tool_calls: turn.tools.length,
      failed_tool_calls: turn.toolErrors,
      next_message: clip(turn.next, 3000),
    },
    questions: { fell_short: FELL_SHORT },
  });
  return result.answers.fell_short?.noul ?? null;
}

const loadJSON = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/**
 * Asks Jev, for every turn the user followed up on, whether the follow-up says the turn fell
 * short, and tallies the rate by the model that served the turn. Answers are cached by turn.
 */
export async function scan(days, { onProgress } = {}) {
  const cache = loadJSON(SCAN_FILE, {});
  const turns = collectTurns(days).filter((t) => t.next);
  const todo = turns.filter((t) => !(t.id in cache));
  let done = 0;
  await pool(todo, 8, async (t) => {
    try {
      cache[t.id] = await fellShort(t);
    } catch {
      // Left out of the cache, so a later run retries it.
    }
    onProgress?.(++done, todo.length);
  });
  privateDir(QUALITY_DIR);
  writeFileSync(SCAN_FILE, JSON.stringify(cache), { mode: 0o600 });
  const byModel = {};
  for (const t of turns) {
    const p = cache[t.id];
    if (typeof p !== "number") continue;
    // Turns where the executor consulted the advisor are counted apart, to see what it buys.
    const b = (byModel[`${mainModel(t)}${t.advice ? " +advisor" : ""}`] ??= { turns: 0, short: 0, examples: [] });
    b.turns++;
    if (p >= 0.5) {
      b.short++;
      b.examples.push({ p, prompt: t.prompt, next: t.next });
    }
  }
  return { days, turns: turns.length, asked: todo.length, byModel };
}

/** 95% Wilson interval for a rate, so a handful of turns is not read as a measurement. */
const wilson = (k, n) => {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const mid = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
};

const pct = (x) => `${(x * 100).toFixed(0)}%`;

export function formatScan(s) {
  const lines = [
    `Turns the user followed up on, last ${s.days} days: ${s.turns} (${s.asked} newly checked)`,
    "",
    "  served by                 turns   fell short   95% range",
  ];
  const rows = Object.entries(s.byModel).sort((a, b) => b[1].turns - a[1].turns);
  for (const [model, b] of rows) {
    const [lo, hi] = wilson(b.short, b.turns);
    lines.push(
      `  ${model.padEnd(24)} ${String(b.turns).padStart(5)}   ${pct(b.short / b.turns).padStart(10)}   ${pct(lo)}-${pct(hi)}`,
    );
  }
  lines.push(
    "",
    "Cheaper models get easier turns, so a similar or lower rate is expected; a clearly higher",
    "one means routing is costing quality. Examples of turns that fell short:",
  );
  for (const [model, b] of rows) {
    if (tierOf(model) === "opus") continue;
    for (const e of b.examples.slice(0, 5)) {
      lines.push(`  [${model}] p=${e.p.toFixed(2)} ${clip(e.prompt, 70).replace(/\s+/g, " ")}`);
      lines.push(`      next: ${clip(e.next, 90).replace(/\s+/g, " ")}`);
    }
  }
  return lines.join("\n");
}

// The judge's idea of each tier. It is the same split the router's guidance describes, so
// the eval measures whether Jev applies it from the prompt alone, before the work happens.
const JUDGE_SYSTEM = `You review turns from a developer's Claude Code sessions to calibrate a model router. For each turn you see the request, a summary of the conversation before it, what the assistant did, its final reply, and the developer's next message.

Decide two things.

1. needed: the cheapest model that would very likely have completed this turn fully and correctly in one pass, judged by what the work actually turned out to involve.
- haiku (Claude Haiku 5.5): work that needs no real thinking or combining of information. Looking something up, running a command and reporting it, reading one thing and summarising it, a fully specified mechanical edit, a simple factual answer, committing finished work.
- sonnet (Claude Sonnet 5.5): most everyday engineering, and close to Opus on most coding. Implementing features with clear behaviour, debugging from a visible error, multi-file changes that follow a pattern, tests, explanations, scripts, configuration, system administration with clear steps, combining several sources into an answer.
- opus (Claude Opus 5.5): only work where Sonnet would likely fall short. Diagnosing a failure whose cause is unknown across components or the system, subtle concurrency, security or data-loss risk, architecture with many interacting constraints, long ambiguous autonomous work, or a retry after earlier attempts failed.
When torn between two models, choose the more capable one.

2. served_ok: whether the turn achieved what the developer asked, judged from the reply and the next message: "yes", "minor" (small slips the developer had to point out), or "no" (wrong, failed, or redone).

Give a one-sentence reason.`;

const JUDGE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    needed: { type: "string", enum: ["haiku", "sonnet", "opus"] },
    served_ok: { type: "string", enum: ["yes", "minor", "no"] },
    why: { type: "string" },
  },
  required: ["needed", "served_ok", "why"],
  additionalProperties: false,
});

// Sub-agent tasks have no developer follow-up: the reply goes back to the main agent.
const SUBAGENT_NOTE = `

Some turns are sub-agent tasks: the main agent delegated the request, and the final reply goes back to the main agent, not the developer. For those, judge served_ok by whether the final reply answers the task correctly and completely, and needed by the work the task actually took.`;

/** What the judge reads about one turn, bounded to a few thousand tokens. */
export function judgeInput(turn) {
  const history = recentContext({ messages: [...turn.prior, { role: "user", content: turn.prompt }] });
  return JSON.stringify(
    {
      ...(turn.subagent && { kind: "sub-agent task delegated by the main agent" }),
      conversation_before: history ?? "none: this is the first request",
      request: clip(turn.prompt, 6000),
      what_the_assistant_did: {
        api_requests: turn.requests,
        tool_calls: turn.tools.slice(0, 60).map((t) => `${t.name} ${t.input}`),
        ...(turn.tools.length > 60 && { more_tool_calls: turn.tools.length - 60 }),
        failed_tool_calls: turn.toolErrors,
        sample_tool_results: turn.results.slice(0, 15),
      },
      final_reply: clip(turn.reply, 4000) || "(none)",
      next_message: turn.subagent
        ? "(none: a sub-agent's reply goes to the main agent)"
        : turn.next
          ? clip(turn.next, 2000)
          : "(none: the session ended or moved on)",
    },
    null,
    1,
  );
}

/**
 * Runs one judgement through the Claude Code CLI on Opus 5.5 with no tools, MCP servers,
 * settings or hooks, so it uses the user's own login and cannot act on the machine. Any
 * router settings inherited from a `cj` session are removed, so it is never routed itself.
 */
function runJudge(input) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^ANTHROPIC_(BASE_URL|MODEL|CUSTOM_MODEL_OPTION)/.test(key)) delete env[key];
  }
  const cwd = join(QUALITY_DIR, "cwd");
  privateDir(cwd);
  const args = [
    "-p", "--model", "claude-opus-5-5", "--effort", "high", "--tools", "", "--strict-mcp-config",
    "--setting-sources", "", "--no-session-persistence", "--output-format", "json",
    "--system-prompt", JUDGE_SYSTEM + SUBAGENT_NOTE, "--json-schema", JUDGE_SCHEMA,
  ];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const r = JSON.parse(out);
        resolve(r.structured_output ? { ...r.structured_output, cost: r.total_cost_usd ?? 0 } : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(input);
  });
}

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Judges `count` turns not judged before: every turn served by a cheaper model first, up to
 * half the count, because those are where routing can cost quality, and the rest from turns
 * served by Opus, where routing may have spent more than needed. Appends to JUDGED_FILE in
 * the eval's scenario format.
 */
/**
 * Sub-agent tasks from the last `days` days, at most `perTier` served by each tier. Sub-agent
 * transcripts run to tens of gigabytes, so files are sampled before any is read.
 */
function subagentTurns(days, perTier, skip) {
  const since = Date.now() - days * 86400000;
  const files = shuffle(transcriptFiles(undefined, since).filter((f) => /[\\/]subagents[\\/]/.test(f)));
  const byTier = { haiku: [], sonnet: [], opus: [] };
  for (const file of files) {
    if (Object.values(byTier).every((list) => list.length >= perTier)) break;
    const [task] = readTurns(file);
    const tier = task && tierOf(mainModel(task));
    if (!task || !task.requests || task.at < since || skip.has(task.id) || !byTier[tier]) continue;
    if (byTier[tier].length < perTier) byTier[tier].push(task);
  }
  return Object.values(byTier).flat();
}

export async function judge(count, days, { onProgress, subagents = false } = {}) {
  const already = new Set();
  try {
    for (const line of readFileSync(JUDGED_FILE, "utf8").split("\n")) if (line) already.add(JSON.parse(line).id);
  } catch {
    // Nothing judged yet.
  }
  let turns;
  let picked;
  if (subagents) {
    // Sub-agents already run on every tier, so each gets an equal share of the sample.
    turns = picked = subagentTurns(days, Math.ceil(count / 3), already).slice(0, count);
  } else {
    turns = collectTurns(days).filter((t) => !already.has(t.id) && t.prompt.length > 1 && tierOf(mainModel(t)));
    const cheap = shuffle(turns.filter((t) => tierOf(mainModel(t)) !== "opus" && tierOf(mainModel(t)) !== "fable"));
    const strong = shuffle(turns.filter((t) => tierOf(mainModel(t)) === "opus"));
    picked = cheap.slice(0, Math.floor(count / 2));
    picked.push(...strong.slice(0, count - picked.length));
  }
  privateDir(join(homedir(), ".cache", "claude-jev", "eval"));
  const results = [];
  let done = 0;
  await pool(picked, 4, async (t) => {
    const verdict = await runJudge(judgeInput(t));
    onProgress?.(++done, picked.length);
    if (!verdict) return;
    const row = {
      id: t.id,
      at: t.at,
      served: mainModel(t),
      ...(t.subagent && { subagent: true }),
      tier: verdict.needed,
      served_ok: verdict.served_ok,
      why: verdict.why,
      prompt: t.prompt,
      prior: t.prior,
    };
    results.push({ ...row, cost: verdict.cost });
    appendFileSync(JUDGED_FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  });
  return { days, candidates: turns.length, picked: picked.length, results };
}

/** Summary of every judged turn so far, plus what this run added. */
export function formatJudged(run) {
  let rows = [];
  try {
    rows = readFileSync(JUDGED_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // Nothing judged.
  }
  const cost = run.results.reduce((a, r) => a + r.cost, 0);
  const lines = [
    `Judged ${run.results.length} of ${run.picked} turns this run (≈$${cost.toFixed(2)} at list prices); ${rows.length} judged in all.`,
    "",
    "Model the judge says each turn needed, by the model that served it:",
    "  served by                    needed: haiku  sonnet  opus   served ok / minor / no",
  ];
  const by = {};
  for (const r of rows) {
    const b = (by[`${r.subagent ? "sub-agent " : ""}${r.served}`] ??= { haiku: 0, sonnet: 0, opus: 0, yes: 0, minor: 0, no: 0 });
    b[r.tier]++;
    b[r.served_ok]++;
  }
  for (const [model, b] of Object.entries(by).sort()) {
    lines.push(
      `  ${model.padEnd(34)} ${String(b.haiku).padStart(5)} ${String(b.sonnet).padStart(7)} ${String(b.opus).padStart(5)}   ${b.yes} / ${b.minor} / ${b.no}`,
    );
  }
  const rank = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
  const under = rows.filter((r) => rank[tierOf(r.served)] < rank[r.tier]);
  if (under.length) {
    lines.push("", "Served by a weaker model than the judge says was needed:");
    for (const r of under.slice(0, 10)) {
      lines.push(`  [${r.served} -> needed ${r.tier}, ok=${r.served_ok}] ${clip(r.prompt, 70).replace(/\s+/g, " ")}`);
      lines.push(`      ${clip(r.why, 110)}`);
    }
  }
  lines.push("", `Labels are in ${JUDGED_FILE}; \`npm run eval\` now scores routing against them.`);
  return lines.join("\n");
}

const DELEGATING_TOOLS = new Set(["Agent", "Task"]);

/**
 * How often Claude acted on the delegation hint: of the turns the prompt hook flagged as
 * bulky gathering, how many used a sub-agent, against the rate on turns it did not flag.
 */
export function hints(days) {
  const turns = collectTurns(days);
  const delegated = (t) => t.tools.some((tool) => DELEGATING_TOOLS.has(tool.name));
  const hinted = turns.filter((t) => t.hint != null);
  const plain = turns.filter((t) => t.hint == null);
  return {
    days,
    hinted: hinted.length,
    hintedDelegated: hinted.filter(delegated).length,
    plain: plain.length,
    plainDelegated: plain.filter(delegated).length,
    ignored: hinted.filter((t) => !delegated(t)).map((t) => ({ p: t.hint, prompt: t.prompt, requests: t.requests })),
  };
}

export function formatHints(h) {
  const rate = (k, n) => (n ? `${k}/${n} (${pct(k / n)})` : "none");
  const lines = [
    `Delegation hint, last ${h.days} days`,
    `  turns with the hint that used a sub-agent:     ${rate(h.hintedDelegated, h.hinted)}`,
    `  turns without the hint that used a sub-agent:  ${rate(h.plainDelegated, h.plain)}`,
  ];
  if (h.ignored.length) {
    lines.push("", "Hinted turns done without a sub-agent:");
    for (const t of h.ignored.slice(0, 10)) {
      lines.push(`  p=${t.p.toFixed(2)} ${t.requests} requests | ${clip(t.prompt, 80).replace(/\s+/g, " ")}`);
    }
  }
  if (h.hinted >= 10 && h.hintedDelegated / h.hinted <= h.plainDelegated / Math.max(1, h.plain)) {
    lines.push("", "Claude delegates no more often with the hint than without it; consider CJ_NO_DELEGATION_HINT=1.");
  }
  return lines.join("\n");
}

// Share of turns that fell short on Opus 5.5 over the two weeks before routing changed
// (814 turns, 2026-10-04 to 2026-10-18): the baseline when a week has too few Opus turns.
const OPUS_BASELINE = 0.05;

/**
 * A warning when turns on a cheaper model fall short clearly more often than on Opus: at
 * least 50 turns, five points above the Opus rate, and the lower end of the 95% interval
 * still above it. Null when nothing stands out.
 */
export function weeklyWarning(s) {
  const tiers = {};
  for (const [model, b] of Object.entries(s.byModel)) {
    const tier = tierOf(model);
    if (!tier) continue;
    const t = (tiers[tier] ??= { turns: 0, short: 0 });
    t.turns += b.turns;
    t.short += b.short;
  }
  const opus = tiers.opus;
  const baseline = opus?.turns >= 30 ? opus.short / opus.turns : OPUS_BASELINE;
  for (const tier of ["haiku", "sonnet"]) {
    const t = tiers[tier];
    // 33 Sonnet turns in the first week tripped it on one real miss and two debugging turns.
    if (!t || t.turns < 50) continue;
    const rate = t.short / t.turns;
    if (rate - baseline >= 0.05 && wilson(t.short, t.turns)[0] > baseline) {
      return `${tier} turns fell short ${pct(rate)} of the time against ${pct(baseline)} on Opus (${t.turns} turns); consider raising enoughProbability`;
    }
  }
  return null;
}
