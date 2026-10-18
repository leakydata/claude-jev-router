import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, formatReport } from "../src/report.mjs";
import { costOf } from "../src/pricing.mjs";

const at = "2026-10-18T12:00:00Z";
const reply = (id, model, usage, extra = {}) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage }, ...extra });
const toolResult = JSON.stringify({ type: "user", timestamp: at, message: { content: [{ type: "tool_result" }] } });
const compaction = JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cj-report-"));
  const main = join(root, "session.jsonl");
  const sub = join(root, "session", "subagents", "agent-1.jsonl");
  mkdirSync(join(root, "session", "subagents"), { recursive: true });
  const usage = { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 };
  // The same response written three times, with a tool result in between, counts once.
  writeFileSync(main, [reply("a", "claude-opus-5-5", usage), toolResult, reply("a", "claude-opus-5-5", usage), reply("a", "claude-opus-5-5", usage), compaction, ""].join("\n"));
  writeFileSync(sub, `${reply("b", "claude-haiku-5-5", usage)}\n`);
  return { root, main, sub, cacheFile: join(root, "cache.json") };
}

test("totals each response once and attributes sub-agents and compactions", async () => {
  const { main, sub, cacheFile } = fixture();
  const s = await summarize([main, sub], 0, { cacheFile });
  assert.equal(s.total.requests, 2);
  // Haiku 5.5 charges five times its base rates for prompts over 100K tokens.
  assert.ok(Math.abs(s.total.dollars - (0.2 + 0.05)) < 1e-9, "1M cache-read tokens on Opus 5.5 and Haiku 5.5");
  assert.equal(s.subagents.requests, 1);
  assert.equal(s.compactions, 1);
  assert.match(formatReport(s, 7), /claude-opus-5-5/);
});

test("appended lines are picked up and earlier ones are not counted twice", async () => {
  const { main, sub, cacheFile } = fixture();
  await summarize([main, sub], 0, { cacheFile });
  appendFileSync(main, `${reply("c", "claude-sonnet-5-5", { output_tokens: 1_000_000 })}\n`);
  const s = await summarize([main, sub], 0, { cacheFile });
  assert.equal(s.total.requests, 3);
  assert.ok(Math.abs(s.byModel["claude-sonnet-5-5"].dollars - 10) < 1e-9);
});

test("a line still being written is left for the next run", async () => {
  const { main, cacheFile } = fixture();
  appendFileSync(main, reply("d", "claude-opus-5-5", { output_tokens: 1 }).slice(0, 40));
  const first = await summarize([main], 0, { cacheFile });
  assert.equal(first.total.requests, 1);
  appendFileSync(main, `${reply("d", "claude-opus-5-5", { output_tokens: 1 }).slice(40)}\n`);
  const second = await summarize([main], 0, { cacheFile });
  assert.equal(second.total.requests, 2);
});

test("prices cache writes by TTL and Haiku's long prompts at the higher rate", () => {
  const writes = costOf("claude-opus-5-5", {
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
  });
  assert.ok(Math.abs(writes.dollars.cache_write - (4 * 1.25 + 4 * 2)) < 1e-9);
  const long = costOf("claude-haiku-5-5", { input_tokens: 200_000 });
  assert.ok(Math.abs(long.dollars.input - 0.2 * 0.5) < 1e-9);
  assert.equal(costOf("cj-auto", { input_tokens: 5 }), null);
});
