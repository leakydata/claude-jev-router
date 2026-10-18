import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainModel, readTurns } from "../src/turns.mjs";
import { judgeInput } from "../src/quality.mjs";

const line = (o) => JSON.stringify({ timestamp: "2026-10-18T12:00:00Z", uuid: Math.random().toString(36).slice(2), ...o });
const user = (content, extra) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (id, model, content) => line({ type: "assistant", message: { role: "assistant", id, model, content } });

function transcript(lines) {
  const file = join(mkdtempSync(join(tmpdir(), "cj-turns-")), "session.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("splits a transcript into turns with their models, tools and next prompt", () => {
  const big = "x".repeat(300 * 1024);
  const file = transcript([
    user("fix the flaky test"),
    user("<command-name>/model</command-name>", { isMeta: true }),
    assistant("m1", "claude-sonnet-5-5", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]),
    assistant("m1", "claude-sonnet-5-5", [{ type: "text", text: "running tests" }]),
    user([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: big }]),
    assistant("m2", "claude-sonnet-5-5", [{ type: "text", text: "Fixed: the timeout was too short." }]),
    user("still failing on CI"),
    assistant("m3", "claude-opus-5-5", [{ type: "text", text: "CI uses a slower runner." }]),
  ]);
  const [first, second] = readTurns(file);
  assert.equal(first.prompt, "fix the flaky test");
  assert.deepEqual(first.models, { "claude-sonnet-5-5": 2 }, "one request per response id");
  assert.equal(first.tools[0].name, "Bash");
  assert.equal(first.toolErrors, 1, "an error in an oversized result line still counts");
  assert.equal(first.reply, "Fixed: the timeout was too short.");
  assert.equal(first.next, "still failing on CI");
  assert.equal(mainModel(second), "claude-opus-5-5");
  assert.equal(second.next, null);
  assert.ok(second.prior.length >= 4, "the conversation before the prompt comes along");
});

test("the judge sees the work and the follow-up, bounded", () => {
  const file = transcript([
    user("rename foo to bar"),
    assistant("m1", "claude-haiku-5-5", [{ type: "text", text: "y".repeat(20000) }]),
    user("thanks"),
  ]);
  const input = JSON.parse(judgeInput(readTurns(file)[0]));
  assert.equal(input.request, "rename foo to bar");
  assert.equal(input.next_message, "thanks");
  assert.ok(input.final_reply.length < 5000);
});
