// Scores Jev's live routing against labelled scenarios: the synthetic ones in the repo plus,
// when present, the user's own labelled prompts in ~/.cache/claude-jev/eval/labelled.jsonl.
// Makes real Jev calls, so it needs JEV_API_KEY. usage: npm run eval
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

function localScenarios() {
  try {
    return readFileSync(LOCAL_SET, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ ...JSON.parse(line), local: true }))
      .filter((s) => rankOf(s.tier) >= 0);
  } catch {
    return [];
  }
}

const models = claudeModels().filter((m) => m.tier !== "fable");
const cases = [...SCENARIOS, ...localScenarios()];
let right = 0;
let under = 0;
let over = 0;
let taskRight = 0;
let taskTotal = 0;
for (const s of cases) {
  const body = { messages: [...(s.prior ?? []), { role: "user", content: s.prompt }] };
  const jev = await askJev({
    prompt: s.prompt,
    current: "claude-opus-5-5",
    contextTokens: Math.round(JSON.stringify(body.messages).length / 4),
    models,
    history: recentContext(body),
  });
  // Score what would actually run: Jev's answer after the routing policy, starting from Opus
  // early in a conversation, where every downgrade is allowed on cache grounds.
  const raw = models.find((m) => m.id === jev?.choice)?.tier ?? "none";
  const { tier: got, reason } = decide({
    prompt: s.prompt,
    jev: jev && { ...jev, choice: raw },
    current: "opus",
    available: [...new Set(models.map((m) => m.tier))],
    contextTokens: 0,
  });
  const delta = rankOf(got) - rankOf(s.tier);
  if (delta === 0) right++;
  else if (delta < 0) under++;
  else over++;
  let task = "";
  if (s.newTask !== undefined && jev?.newTask != null) {
    taskTotal++;
    const said = jev.newTask >= THRESHOLDS.newTaskProbability;
    if (said === s.newTask) taskRight++;
    task = ` new-task ${said === s.newTask ? "ok" : "XX"} p=${jev.newTask.toFixed(2)}`;
  }
  const mark = delta === 0 ? "ok   " : delta < 0 ? "UNDER" : "over ";
  const text = `${s.local ? "[yours] " : ""}${s.prompt.slice(0, 70).replace(/\s+/g, " ")}`;
  const held = raw !== got ? ` (jev said ${raw}, ${reason.split("/")[0]})` : "";
  console.log(`${mark} want=${s.tier.padEnd(6)} got=${got.padEnd(6)} p=${(jev?.confidence ?? 0).toFixed(2)}${held}${task} | ${text}`);
}
console.log(
  `\nmodel: ${right}/${cases.length} right, ${under} under-routed (quality risk), ${over} over-routed (cost)` +
    (taskTotal ? `; new-task: ${taskRight}/${taskTotal}` : ""),
);
process.exitCode = under > 0 ? 1 : 0;
