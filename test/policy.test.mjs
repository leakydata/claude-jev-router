import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride, switchPays } from "../src/policy.mjs";
import { QUESTIONS, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  const out = decide({ ...base, jev: sure("opus") });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "jev");
  assert.equal(out.changed, true);
  assert.ok(out.enough >= 0.95);
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use fast"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});



test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});


test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});


const split = (haiku, sonnet, opus) => ({ choice: "haiku", confidence: 0.4, tierProbabilities: { haiku, sonnet, opus } });

test("picks the cheapest tier that is probably enough, not Jev's top choice", () => {
  // Haiku is the single likeliest answer, but Sonnet or cheaper is only 64% likely to do it.
  assert.equal(decide({ ...base, current: "opus", jev: split(0.5, 0.14, 0.36) }).tier, "opus");
  assert.equal(decide({ ...base, current: "opus", jev: split(0.52, 0.47, 0.01) }).tier, "sonnet");
  assert.equal(decide({ ...base, current: "opus", jev: split(0.9, 0.08, 0.02) }).tier, "haiku");
});

test("without probabilities, doubt keeps the more capable model", () => {
  const down = decide({ ...base, current: "opus", jev: { choice: "haiku", confidence: 0.4 } });
  assert.equal(down.tier, "opus");
  const up = decide({ ...base, current: "haiku", jev: { choice: "opus", confidence: 0.4 } });
  assert.equal(up.tier, "opus", "an unsure upgrade still goes up");
});

test("refuses a downgrade once rebuilding the cache costs more than it saves", () => {
  const at = (promptTokens, warm) =>
    decide({ ...base, current: "opus", jev: split(0.05, 0.9, 0.05), cache: { promptTokens, warm } });
  assert.equal(at(500000, { opus: 500000 }).tier, "opus");
  assert.match(at(500000, { opus: 500000 }).reason, /cache-rebuild/);
  assert.equal(at(60000, { opus: 60000 }).tier, "sonnet", "a small conversation is cheap to move");
  assert.equal(at(500000, {}).tier, "sonnet", "an expired cache is rebuilt either way");
  assert.equal(at(500000, { opus: 500000, sonnet: 480000 }).tier, "sonnet", "going back to a warm cache is cheap");
});

test("moving a long conversation to Haiku pays sooner than to Sonnet", () => {
  const big = { cache: { promptTokens: 300000, warm: { opus: 300000 } } };
  assert.equal(switchPays("opus", "haiku", big), true);
  assert.equal(switchPays("opus", "sonnet", big), false);
});

test("a turn that fell short is retried a tier up", () => {
  const missed = { ...split(0.1, 0.85, 0.05), fellShort: 0.9 };
  const out = decide({ ...base, current: "sonnet", jev: missed });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "step-up-after-miss");
  assert.equal(decide({ ...base, current: "haiku", jev: { ...split(0.9, 0.05, 0.05), fellShort: 0.9 } }).tier, "sonnet");
  assert.equal(decide({ ...base, current: "sonnet", jev: { ...missed, fellShort: 0.2 } }).tier, "sonnet");
  assert.equal(decide({ ...base, current: "opus", jev: missed }).tier, "opus", "never steps up into fable");
});

test("a quick question mid-conversation stays put unless Haiku pays back within a turn", () => {
  const warmSonnet = (tokens) => ({ promptTokens: tokens, warm: { sonnet: tokens } });
  assert.equal(switchPays("sonnet", "haiku", { cache: warmSonnet(193000) }), false, "Haiku's long-prompt rate makes a cold 193K write cost more than a turn saves");
  assert.equal(switchPays("sonnet", "haiku", { cache: warmSonnet(40000) }), true, "a short conversation still moves down");
});
