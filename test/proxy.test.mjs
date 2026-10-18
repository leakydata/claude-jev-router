import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  claudeModels,
  conversationKey,
  sessionOf,
  startProxy,
  recentContext,
  readResponseUsage,
} from "../src/proxy.mjs";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { jevRequest } from "../src/router.mjs";
import { questionForModels } from "../src/config.mjs";

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("cj-auto"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5-20251001"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("cj-auto"), null);
});
import { tierOf, isAuto, supportsModernThinking } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, readUsage, pruneStale, STATUS_DIR } from "../src/status.mjs";
import { mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

test("keeps available Claude model versions as separate Jev choices", () => {
  assert.deepEqual(
    claudeModels([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    ]).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "claude-opus-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
  );
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          data: [
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          ],
        }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-4-8"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "cj-auto",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "cj-auto",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

const LEGACY_HAIKU = "claude-haiku-4-5-20251001";

test("routing to a legacy haiku strips fields it cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku", LEGACY_HAIKU);
  assert.equal(body.model, LEGACY_HAIKU);
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to a legacy haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku", LEGACY_HAIKU);
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to haiku 5.5 leaves thinking and effort intact", () => {
  const body = {
    model: "claude-opus-5-5",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_thinking_20251015" }] });
});

test("only the 4.5 generation and older lack adaptive thinking and effort", () => {
  for (const id of ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022"]) {
    assert.equal(supportsModernThinking(id), false, id);
  }
  for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-fable-5-1"]) {
    assert.equal(supportsModernThinking(id), true, id);
  }
});

test("the account catalogue is ordered newest first whatever order the API returned", () => {
  const out = claudeModels([
    { id: "claude-haiku-4-5", created_at: "2025-10-01T00:00:00Z" },
    { id: "claude-haiku-5-5", created_at: "2026-09-01T00:00:00Z" },
  ]);
  assert.deepEqual(out.map((m) => m.id), ["claude-haiku-5-5", "claude-haiku-4-5"]);
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

const said = (role, text, extra = []) => ({ role, content: [{ type: "text", text }, ...extra] });

test("a follow-up carries the earlier requests, the last reply, and recent tool use to Jev", () => {
  const ctx = recentContext({
    messages: [
      said("user", "<system-reminder>noise</system-reminder>the websocket server drops messages, investigate"),
      said("assistant", "It is a race in the flush.", [
        { type: "tool_use", id: "a", name: "Edit", input: { file_path: "src/queue.ts" } },
        { type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } },
      ]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }, { type: "tool_result", tool_use_id: "b", content: "fail", is_error: true }] },
      said("assistant", "Tests still fail. Want me to add a per-connection lock?"),
      said("user", "yes, go ahead"),
    ],
  });
  assert.deepEqual(ctx, {
    earlier_user_requests: ["the websocket server drops messages, investigate"],
    last_assistant_reply: "Tests still fail. Want me to add a per-connection lock?",
    recent_tool_use: { calls_by_tool: { Edit: 1, Bash: 1 }, files_changed: ["src/queue.ts"], failed_tool_calls: 1 },
  });
});

test("the first prompt of a conversation has no context", () => {
  assert.equal(recentContext({ messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(recentContext({}), null);
});

test("a compaction summary is passed as a summary, not as a request", () => {
  const ctx = recentContext({
    messages: [
      { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: migrating auth." },
      said("user", "now"),
    ],
  });
  assert.match(ctx.summary_of_earlier_conversation, /migrating auth/);
  assert.deepEqual(ctx.earlier_user_requests, []);
});

test("long context is clipped, keeping both ends", () => {
  const ctx = recentContext({
    messages: [said("user", `START ${"x".repeat(5000)} END`), said("user", "next")],
  });
  const [req] = ctx.earlier_user_requests;
  assert.ok(req.length < 2000);
  assert.match(req, /^START/);
  assert.match(req, /END$/);
});

test("the Jev request carries the conversation only when there is one", () => {
  const models = [{ id: "claude-haiku-5-5", tier: "haiku" }];
  const base = { prompt: "yes", current: "claude-opus-5-5", contextTokens: 10, models };
  assert.equal(jevRequest(base).state.conversation_before_request, undefined);
  const history = { earlier_user_requests: ["fix the race"] };
  assert.deepEqual(jevRequest({ ...base, history }).state.conversation_before_request, history);
});

test("model choices carry exact-model facts and flag older versions in a tier", () => {
  const { criteria } = questionForModels([
    { id: "claude-haiku-5-5", tier: "haiku" },
    { id: "claude-haiku-4-5", tier: "haiku" },
    { id: "some-future-model", tier: "haiku" },
  ]);
  assert.match(criteria["claude-haiku-5-5"].facts, /Haiku 5\.5/);
  assert.equal(criteria["claude-haiku-5-5"].version, undefined);
  assert.match(criteria["claude-haiku-4-5"].version, /claude-haiku-5-5 is newer/);
  assert.ok(criteria["claude-haiku-5-5"].good_for.length > 1);
  assert.equal(criteria["some-future-model"].facts, undefined, "unknown models get tier guidance only");
});

test("a prompt followed by hook output in a trailing system message is still a new turn", () => {
  const body = {
    tools: [{ name: "Bash" }],
    messages: [
      said("user", "fix the race"),
      { role: "system", content: [{ type: "text", text: "SessionStart hook additional context" }] },
    ],
  };
  assert.equal(newTurnPrompt(body), "fix the race");
  assert.equal(recentContext(body), null, "the prompt itself is not earlier context");
});

test("trailing system messages do not hide the earlier conversation", () => {
  const ctx = recentContext({
    messages: [
      said("user", "investigate the race"),
      said("assistant", "Found it; shall I fix it?"),
      said("user", "yes"),
      { role: "system", content: "hook output" },
    ],
  });
  assert.deepEqual(ctx.earlier_user_requests, ["investigate the race"]);
  assert.equal(ctx.last_assistant_reply, "Found it; shall I fix it?");
});

/** A fake Anthropic upstream that records request bodies, plus a proxy in front of it. */
async function harness(t, route, usage = { input_tokens: 10, output_tokens: 5 }) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) {
        return res.end(JSON.stringify({ data: [
          { id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" },
        ] }));
      }
      const body = JSON.parse(Buffer.concat(chunks));
      seen.push(body);
      res.end(JSON.stringify({ id: "m", type: "message", model: body.model, usage }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const proxy = await startProxy({ upstreamURL: `http://127.0.0.1:${upstream.address().port}`, route });
  t.after(proxy.close);
  const base = `http://127.0.0.1:${proxy.port}`;
  await fetch(`${base}/v1/models`).then((r) => r.json());
  const send = (body) =>
    fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json());
  send.base = base;
  return { seen, send };
}

const sid = () => `sub-${process.pid}-${Math.random().toString(36).slice(2)}`;
const turn = (session, model, text) => ({
  model,
  metadata: { user_id: JSON.stringify({ session_id: session }) },
  tools: [{ name: "Bash" }],
  messages: [{ role: "user", content: text }],
});

test("a sub-agent asking for a concrete model can be routed down from it", async (t) => {
  const calls = [];
  const { seen, send } = await harness(t, async (args) => {
    calls.push(args);
    return { choice: args.subagent ? "claude-haiku-5-5" : "claude-opus-5-5", confidence: 0.95, ms: 1 };
  });
  const s = sid();
  await send(turn(s, "cj-auto", "main task"));
  await send(turn(s, "claude-opus-5-5", "search the repo for where retries are configured"));
  assert.equal(seen[1].model, "claude-haiku-5-5");
  assert.equal(calls[1].subagent, true);
  assert.equal(readStatus(s).model, "claude-opus-5-5", "the main conversation's status is untouched");
  assert.equal(readStatus(s).history.at(-1).subagent, true);
});

test("a sub-agent is never routed above the model it asked for", async (t) => {
  const calls = [];
  const { seen, send } = await harness(t, async (args) => {
    calls.push(args);
    return { choice: "claude-opus-5-5", confidence: 0.99, ms: 1 };
  });
  const s = sid();
  await send(turn(s, "cj-auto", "main task"));
  await send(turn(s, "claude-haiku-5-5", "list the files in src"));
  assert.equal(seen[1].model, "claude-haiku-5-5");
  assert.deepEqual(calls[1].models.map((m) => m.id), ["claude-haiku-5-5"], "only models up to the ceiling are offered");
});

test("picking a model by hand pauses routing for that session's sub-agents too", async (t) => {
  let calls = 0;
  const { seen, send } = await harness(t, async () => {
    calls++;
    return { choice: "claude-haiku-5-5", confidence: 0.99, ms: 1 };
  });
  const s = sid();
  await send(turn(s, "claude-opus-5-5", "main task on a model the user picked"));
  await send(turn(s, "claude-opus-5-5", "a sub-agent task"));
  assert.equal(seen[1].model, "claude-opus-5-5");
  assert.equal(calls, 0);
  assert.equal(readStatus(s).manual, true);
});

test("after compaction the summarised conversation is still the main one", async (t) => {
  const calls = [];
  const { send } = await harness(t, async (args) => {
    calls.push(args);
    return { choice: "claude-sonnet-5-5", confidence: 0.9, ms: 1 };
  });
  const s = sid();
  // A resumed session's first request can be the compaction of the old conversation.
  await send(turn(s, "cj-auto", "the original first prompt"));
  await send(turn(s, "cj-auto", "This session is being continued from a previous conversation that ran out of context."));
  assert.equal(calls[1].subagent, false);
  assert.equal(readStatus(s).model, "claude-sonnet-5-5", "the status line follows the main conversation");
});

test("a token count does not claim the main conversation", async (t) => {
  const calls = [];
  const { send } = await harness(t, async (args) => {
    calls.push(args);
    return { choice: "claude-sonnet-5-5", confidence: 0.9, ms: 1 };
  });
  const s = sid();
  const base = send.base;
  await fetch(`${base}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(turn(s, "cj-auto", "foo")),
  });
  await send(turn(s, "cj-auto", "main task"));
  assert.equal(calls.at(-1).subagent, false);
});

test("a sub-agent's own model choice does not flip the status line to manual", async (t) => {
  const { send } = await harness(t, async () => ({ choice: "claude-sonnet-5-5", confidence: 0.9, ms: 1 }));
  const s = sid();
  await send(turn(s, "cj-auto", "main task"));
  await send({ ...turn(s, "claude-haiku-4-5", "aux"), tools: undefined });
  await send(turn(s, "some-unknown-model", "a sub-agent on a model we cannot route"));
  assert.notEqual(readStatus(s).manual, true);
});

const streamOf = (text, headers = {}) => Object.assign(Readable.from([text]), { headers });

test("reads usage out of a gzipped event stream", async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":3,"cache_read_input_tokens":900}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
  ].join("");
  const got = await new Promise((resolve) =>
    readResponseUsage(streamOf(gzipSync(sse), { "content-encoding": "gzip" }), (model, usage) => resolve({ model, usage })),
  );
  assert.deepEqual(got, { model: "claude-haiku-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 900, output_tokens: 42 } });
});

test("reads usage out of a plain JSON response", async () => {
  const got = await new Promise((resolve) =>
    readResponseUsage(streamOf(JSON.stringify({ model: "claude-opus-5-5", usage: { output_tokens: 7 } })), (model, usage) =>
      resolve({ model, usage }),
    ),
  );
  assert.deepEqual(got, { model: "claude-opus-5-5", usage: { output_tokens: 7 } });
});

test("the proxy totals each session's real usage and cost", async (t) => {
  const { send } = await harness(t, async () => ({ choice: "claude-opus-5-5", confidence: 0.9, ms: 1 }));
  const s = sid();
  await send(turn(s, "cj-auto", "main task"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const usage = readUsage(s);
  assert.equal(usage.requests, 1);
  assert.deepEqual(usage.tokens, { cache_read: 0, cache_write: 0, input: 10, output: 5 });
  assert.ok(Math.abs(usage.dollars - (10 * 4 + 5 * 20) / 1e6) < 1e-12);
});

test("a long conversation stays put when moving it would cost more than it saves", async (t) => {
  let answer = { choice: "claude-opus-5-5", confidence: 0.9, probabilities: { "claude-opus-5-5": 1 }, ms: 1 };
  const big = { input_tokens: 10, cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000, output_tokens: 5 };
  const { seen, send } = await harness(t, async () => answer, big);
  const s = sid();
  const first = turn(s, "cj-auto", "design the sync engine");
  await send(first);
  answer = { choice: "claude-sonnet-5-5", confidence: 0.9, probabilities: { "claude-sonnet-5-5": 1 }, ms: 1 };
  const next = { ...first, messages: [...first.messages, { role: "assistant", content: "done" }, { role: "user", content: "now add docs" }] };
  await send(next);
  assert.equal(seen[1].model, "claude-opus-5-5");
  assert.match(readStatus(s).reason, /cache-rebuild/);
});

test("a restarted proxy remembers which model a resumed conversation's cache is warm on", async (t) => {
  let answer = { choice: "claude-opus-5-5", confidence: 0.9, probabilities: { "claude-opus-5-5": 1 }, ms: 1 };
  const big = { input_tokens: 10, cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000, output_tokens: 5 };
  const s = sid();
  const first = turn(s, "cj-auto", "design the sync engine");
  {
    const { send } = await harness(t, async () => answer, big);
    await send(first);
  }
  // A second proxy, as after `cj --resume`, with no memory of its own.
  answer = { choice: "claude-sonnet-5-5", confidence: 0.9, probabilities: { "claude-sonnet-5-5": 1 }, ms: 1 };
  const { seen, send } = await harness(t, async () => answer, big);
  const next = { ...first, messages: [...first.messages, { role: "assistant", content: "done" }, { role: "user", content: "now add docs" }] };
  await send(next);
  assert.equal(seen[0].model, "claude-opus-5-5");
  assert.match(readStatus(s).reason, /cache-rebuild/);
});
