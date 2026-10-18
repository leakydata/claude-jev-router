// Scores live routing against labelled scenarios: the synthetic set in scenarios.mjs, plus,
// when present, the user's own labels in ~/.cache/claude-jev/eval/labelled.jsonl and the
// Opus judge's labels of real turns in judged.jsonl beside it (`cj-quality judge`).
// Makes real Jev calls, so it needs JEV_API_KEY.
//
// usage: npm run eval [-- --set synthetic|real|all] [--rescore]
//   --rescore  re-scores the Jev answers saved by the last run, without calling Jev, so a
//              policy or threshold change can be compared on identical answers.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { askJev } from "../../src/router.mjs";
import { claudeModels, recentContext } from "../../src/proxy.mjs";
import { rankOf, THRESHOLDS } from "../../src/config.mjs";
import { decide } from "../../src/policy.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { LOCAL_SET } from "./paths.mjs";

try {
  process.loadEnvFile(join(homedir(), ".claude-jev.env"));
} catch {
  // The key may already be in the environment.
}

const args = process.argv.slice(2);
const set = args.includes("--set") ? args[args.indexOf("--set") + 1] : "all";
const rescore = args.includes("--rescore");
const JUDGED = join(dirname(LOCAL_SET), "judged.jsonl");
const LAST_RUN = join(dirname(LOCAL_SET), "last-run.json");

function readSet(file, source) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ ...JSON.parse(line), source }))
      .filter((s) => rankOf(s.tier) >= 0);
  } catch {
    return [];
  }
}

// The user's own labels win over the judge's for the same prompt.
const yours = readSet(LOCAL_SET, "yours");
const labelled = new Set(yours.map((s) => s.prompt));
const real = [...yours, ...readSet(JUDGED, "judge").filter((s) => !labelled.has(s.prompt))];
const synthetic = SCENARIOS.map((s) => ({ ...s, source: "synthetic" }));
const cases = set === "synthetic" ? synthetic : set === "real" ? real : [...synthetic, ...real];

const models = claudeModels().filter((m) => m.tier !== "fable");
const tierOfId = (id) => models.find((m) => m.id === id)?.tier;

/** Jev's probability, per tier, that the tier is the cheapest one that does the work. */
const tierProbabilities = (jev) => {
  const p = {};
  for (const [id, v] of Object.entries(jev?.probabilities ?? {})) {
    const tier = tierOfId(id);
    if (tier) p[tier] = (p[tier] ?? 0) + v;
  }
  return p;
};

let answers;
if (rescore) {
  answers = JSON.parse(readFileSync(LAST_RUN, "utf8"));
} else {
  answers = {};
  let done = 0;
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const s = queue.shift();
        const body = { messages: [...(s.prior ?? []), { role: "user", content: s.prompt }] };
        const jev = await askJev({
          prompt: s.prompt,
          current: "claude-opus-5-5",
          contextTokens: Math.round(JSON.stringify(body.messages).length / 4),
          models,
          history: recentContext(body),
          subagent: !!s.subagent,
        });
        answers[s.prompt] = jev && {
          choice: jev.choice,
          confidence: jev.confidence,
          probabilities: jev.probabilities,
          newTask: jev.newTask,
          fellShort: jev.fellShort,
        };
        if (process.stderr.isTTY) process.stderr.write(`\rasking Jev ${++done}/${cases.length}`);
      }
    }),
  );
  if (process.stderr.isTTY) process.stderr.write("\n");
  mkdirSync(dirname(LAST_RUN), { recursive: true, mode: 0o700 });
  writeFileSync(LAST_RUN, JSON.stringify(answers), { mode: 0o600 });
}

// Relative list price of a typical request on each tier, Opus = 1: cache reads dominate, and
// those are $0.01, $0.10 and $0.20 per million on Haiku, Sonnet and Opus 5.5.
const COST = { haiku: 0.05, sonnet: 0.5, opus: 1, fable: 1.25 };

/** What the policy would run for one case, early in a conversation on `servedOn` (Opus). */
const routed = (s) => {
  const jev = answers[s.prompt];
  const raw = tierOfId(jev?.choice) ?? "none";
  return decide({
    prompt: s.prompt,
    jev: jev && { ...jev, choice: raw, tierProbabilities: tierProbabilities(jev) },
    current: s.servedOn ?? "opus",
    available: [...new Set(models.map((m) => m.tier))],
  });
};

function score(label, pick) {
  const out = { label, right: 0, under: 0, toHaiku: 0, over: 0, cost: 0, n: 0 };
  for (const s of cases) {
    const got = pick(s);
    if (!got) continue;
    out.n++;
    const delta = rankOf(got) - rankOf(s.tier);
    if (delta === 0) out.right++;
    else if (delta < 0) {
      out.under++;
      if (got === "haiku") out.toHaiku++;
    }
    else out.over++;
    out.cost += COST[got];
  }
  out.cost /= out.n || 1;
  return out;
}

// Per-case detail for the policy as configured.
let taskRight = 0;
let taskTotal = 0;
let shortRight = 0;
let shortTotal = 0;
for (const s of cases) {
  const jev = answers[s.prompt];
  const raw = tierOfId(jev?.choice) ?? "none";
  const { tier: got, reason } = routed(s);
  const delta = rankOf(got) - rankOf(s.tier);
  let task = "";
  if (s.newTask !== undefined && s.newTask !== null && jev?.newTask != null) {
    taskTotal++;
    const said = jev.newTask >= THRESHOLDS.newTaskProbability;
    if (said === s.newTask) taskRight++;
    task = ` new-task ${said === s.newTask ? "ok" : "XX"} p=${jev.newTask.toFixed(2)}`;
  }
  if (s.fellShort !== undefined && jev?.fellShort != null) {
    shortTotal++;
    const said = jev.fellShort >= THRESHOLDS.stepUpProbability;
    if (said === s.fellShort) shortRight++;
    task += ` fell-short ${said === s.fellShort ? "ok" : "XX"} p=${jev.fellShort.toFixed(2)}`;
  }
  const mark = delta === 0 ? "ok   " : delta < 0 ? "UNDER" : "over ";
  const p = tierProbabilities(jev);
  const probs = ["haiku", "sonnet", "opus"].map((t) => (p[t] ?? 0).toFixed(2)).join("/");
  const tag = s.source === "synthetic" ? "" : `[${s.source}${s.subagent ? " sub-agent" : ""}] `;
  const text = `${tag}${s.prompt.slice(0, 64).replace(/\s+/g, " ")}`;
  const held = raw !== got ? ` (jev said ${raw}, ${reason.split("/")[0]})` : "";
  console.log(`${mark} want=${s.tier.padEnd(6)} got=${got.padEnd(6)} p(h/s/o)=${probs}${held}${task} | ${text}`);
}

// The same answers under other policies, to see what a change would do before making it.
const fixed = (tier) => () => tier;
const cumulative = (threshold, haikuBar = threshold) => (s) => {
  const p = tierProbabilities(answers[s.prompt]);
  let sum = 0;
  for (const tier of ["haiku", "sonnet", "opus"]) {
    sum += p[tier] ?? 0;
    if (sum >= (tier === "haiku" ? haikuBar : threshold)) return tier;
  }
  return "opus";
};
const rows = [
  score("policy as configured", (s) => routed(s).tier),
  score("Jev's top choice", (s) => tierOfId(answers[s.prompt]?.choice) ?? "opus"),
  ...[0.5, 0.6, 0.7, 0.8].map((t) => score(`P(enough) >= ${t}`, cumulative(t))),
  ...[
    [0.7, 0.8],
    [0.7, 0.9],
    [0.6, 0.85],
    [0.8, 0.85],
  ].map(([t, h]) => score(`P(enough) >= ${t}, Haiku ${h}`, cumulative(t, h))),
  score("always sonnet", fixed("sonnet")),
  score("always opus", fixed("opus")),
];
console.log(`\n${cases.length} cases (${set}); cost is relative list price per request, always-Opus = 1.00\n`);
console.log("  policy                              right  under (to Haiku)  over   cost");
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(34)} ${String(r.right).padStart(5)}  ${String(r.under).padStart(5)} ${`(${r.toHaiku})`.padStart(10)}  ${String(r.over).padStart(4)}   ${r.cost.toFixed(2)}`,
  );
}
if (taskTotal) console.log(`\nnew-task hint: ${taskRight}/${taskTotal} right`);
if (shortTotal) console.log(`fell-short (step up): ${shortRight}/${shortTotal} right`);
// The synthetic set is the regression check: the run fails when one of its scenarios is
// routed down to Haiku when it needed more, the miss that costs the most quality. Real turns
// are labelled with hindsight by the judge and are reported, not enforced.
const synthetic_ = cases.filter((s) => s.source === "synthetic");
const toHaiku = synthetic_.filter((s) => routed(s).tier === "haiku" && rankOf(s.tier) > 0);
for (const s of toHaiku) console.log(`FAIL: routed to Haiku, needed ${s.tier}: ${s.prompt}`);
process.exitCode = toHaiku.length ? 1 : 0;
