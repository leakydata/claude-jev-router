import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import {
  ADVISOR,
  TIERS,
  tierOf,
  idOf,
  rankOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
  supportsModernThinking,
} from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { advisorCosts, costOf } from "./pricing.mjs";
import { readAdvice, readConversation, writeAdvice, writeConversation, writeDecision, writeStatus, writeSubagentDecision, writeUsage } from "./status.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const last = conversationMessages(body).at(-1);
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return stripReminders(text);
}

/**
 * The messages up to the latest user or assistant one. Claude Code appends hook output, such
 * as SessionStart context, as trailing `role: "system"` messages after the user's prompt, so
 * the prompt is not always the last entry.
 */
function conversationMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === "system") end--;
  return messages.slice(0, end);
}

const stripReminders = (text) =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;

const textBlocks = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : "";

/** Keeps the start and end of a long text, where the ask and the conclusion usually are. */
const clip = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max * 0.6)} […] ${text.slice(-max * 0.4)}`;

// Bounds on what `recentContext` sends. Jev accuracy drops as state fills with detail
// unrelated to the decision, so this is the conversation's recent shape, not a transcript.
const CONTEXT_LIMITS = {
  priorRequests: 6,
  requestChars: 1500,
  replyChars: 3000,
  summaryChars: 4000,
  recentTurnsForTools: 3,
  files: 15,
};

const CONTINUATION = /^This session is being continued from a previous conversation/;

/**
 * What the conversation was doing before the new prompt, for Jev. A follow-up such as
 * "yes, go ahead" or "try again" is only as hard as the work it refers to, and the prompt
 * alone hides that: the earlier requests, the assistant's last reply, and the recent tool
 * activity carry it. Returns null when there is no earlier turn to describe.
 */
export function recentContext(body) {
  const messages = conversationMessages(body).slice(0, -1);
  // A user message that carries typed text, not just tool results, opens a turn.
  const turnStarts = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (typeof m.content === "string" || !blocks.some((b) => b.type === "tool_result")) {
      if (stripReminders(textBlocks(m.content))) turnStarts.push(i);
    }
  });
  if (!turnStarts.length) return null;

  const context = {};
  const firstText = stripReminders(textBlocks(messages[turnStarts[0]].content)) ?? "";
  if (CONTINUATION.test(firstText)) {
    context.summary_of_earlier_conversation = clip(firstText, CONTEXT_LIMITS.summaryChars);
    turnStarts.shift();
  }

  context.earlier_user_requests = turnStarts
    .slice(-CONTEXT_LIMITS.priorRequests)
    .map((i) => clip(stripReminders(textBlocks(messages[i].content)), CONTEXT_LIMITS.requestChars));

  const reply = messages.findLast((m) => m.role === "assistant" && textBlocks(m.content).trim());
  if (reply) context.last_assistant_reply = clip(textBlocks(reply.content).trim(), CONTEXT_LIMITS.replyChars);

  const since = turnStarts.at(-CONTEXT_LIMITS.recentTurnsForTools) ?? 0;
  const tools = {};
  const files = new Set();
  let failures = 0;
  for (const m of messages.slice(since)) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === "tool_use") {
        tools[b.name] = (tools[b.name] ?? 0) + 1;
        const file = b.input?.file_path ?? b.input?.notebook_path;
        if (file && /^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) files.add(file);
      } else if (b.type === "tool_result" && b.is_error) {
        failures++;
      }
    }
  }
  if (Object.keys(tools).length) {
    context.recent_tool_use = {
      calls_by_tool: tools,
      ...(files.size && { files_changed: [...files].slice(-CONTEXT_LIMITS.files) }),
      failed_tool_calls: failures,
    };
  }
  return context.earlier_user_requests.length || context.summary_of_earlier_conversation ? context : null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  // Capability belongs to the exact model, not the tier: the catalogue can serve an older
  // model within a tier that still rejects these fields.
  const modern = supportsModernThinking(model);
  if (!tier.thinking || !modern) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if ((!tier.effort || !modern) && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    // The comment above promises newest-first, and `modelForTier` takes the first match in
    // each tier, so the order has to be enforced rather than inherited from the API response.
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/** Whether a conversation opens with Claude Code's compaction summary. */
export function isContinuation(body) {
  const content = body?.messages?.[0]?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b.text ?? "").join("") : "";
  return text.includes("This session is being continued from a previous conversation");
}

const isAdvisorBlock = (b) =>
  b?.type === "advisor_tool_result" || (b?.type === "server_tool_use" && b.name === "advisor");

/** A stable identity for a response content block, to find it again in later history. */
function fingerprint(b) {
  if (b?.type === "tool_use" || b?.type === "server_tool_use") return b.id ? `id:${b.id}` : null;
  if (b?.type === "thinking") return b.signature ? `th:${b.signature.slice(-48)}` : null;
  if (b?.type === "redacted_thinking") return b.data ? `rt:${b.data.slice(-48)}` : null;
  if (b?.type === "text") return b.text ? `tx:${createHash("sha1").update(b.text).digest("hex")}` : null;
  return null;
}

/**
 * The advisor consultations in one response's content, each with the blocks around it, so
 * they can be put back where they were.
 */
export function adviceRecords(content = []) {
  const records = [];
  content.forEach((b, i) => {
    if (b?.type !== "server_tool_use" || b.name !== "advisor") return;
    const result = content.find((r) => r?.type === "advisor_tool_result" && r.tool_use_id === b.id);
    if (!result) return;
    const others = (from, step) => {
      for (let j = from; j >= 0 && j < content.length; j += step) {
        if (!isAdvisorBlock(content[j])) return fingerprint(content[j]);
      }
      return null;
    };
    records.push({ id: b.id, prev: others(i - 1, -1), next: others(i + 1, 1), blocks: [b, result] });
  });
  return records;
}

/**
 * Puts advisor consultations back into the assistant messages they came from. Claude Code
 * drops these blocks when it replays history, which loses the advice for later requests and
 * makes every consultation rebuild the advisor's prompt cache from scratch.
 */
export function restoreAdvice(body, records) {
  if (!records.length) return;
  const before = new Map();
  const after = new Map();
  for (const r of records) {
    if (r.next) before.set(r.next, [...(before.get(r.next) ?? []), r]);
    else if (r.prev) after.set(r.prev, [...(after.get(r.prev) ?? []), r]);
  }
  for (const m of body.messages ?? []) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const present = new Set(m.content.filter(isAdvisorBlock).map((b) => b.id ?? b.tool_use_id));
    const fresh = (list) => (list ?? []).filter((r) => !present.has(r.id)).flatMap((r) => r.blocks);
    let changed = false;
    const out = [];
    for (const b of m.content) {
      const f = fingerprint(b);
      const pre = fresh(f && before.get(f));
      const post = fresh(f && after.get(f));
      if (pre.length || post.length) changed = true;
      out.push(...pre, b, ...post);
    }
    if (changed) m.content = out;
  }
}

/**
 * Gives a request on an advisor tier the advisor tool and its earlier consultations, and
 * strips consultations from any other request: the API rejects history holding advisor
 * results when the tool is gone, and adding the tool to another tier would change its cached
 * prefix. Returns whether the request needs the advisor beta header.
 */
export function applyAdvisor(body, tier, records = [], { allowed = true } = {}) {
  if (allowed && ADVISOR.enabled() && ADVISOR.tiers.includes(tier) && Array.isArray(body.tools)) {
    if (!body.tools.some((t) => t.type?.startsWith("advisor_"))) {
      body.tools.push({
        type: "advisor_20260301",
        name: "advisor",
        model: ADVISOR.model,
        max_uses: ADVISOR.maxUses,
        // No prompt caching: consultations are usually hours apart, so a cache write (2x
        // input for the hour) was rarely read back. In the first real days 1 of 4 was, and
        // the three cold ones cost about $1.20 each at 130-157K.
      });
      if (typeof body.system === "string") body.system = [{ type: "text", text: body.system }];
      body.system = [...(body.system ?? []), { type: "text", text: ADVISOR.note }];
    }
    restoreAdvice(body, records);
    return true;
  }
  for (const m of body.messages ?? []) {
    if (m.role === "assistant" && Array.isArray(m.content) && m.content.some(isAdvisorBlock)) {
      m.content = m.content.filter((b) => !isAdvisorBlock(b));
    }
  }
  return false;
}

const DECOMPRESS = {
  gzip: zlib.createGunzip,
  "x-gzip": zlib.createGunzip,
  deflate: zlib.createInflate,
  br: zlib.createBrotliDecompress,
  zstd: zlib.createZstdDecompress,
};

/**
 * Reads the served model and token usage out of a Messages API response without touching
 * what the client receives: the response is copied through a decompressor of its own. Handles
 * a server-sent-event stream (`message_start`, then cumulative `message_delta` usage) and a
 * plain JSON body. Calls `onUsage(model, usage)` once, when the response ends.
 */
export function readResponseUsage(stream, onUsage) {
  const encoding = String(stream.headers?.["content-encoding"] ?? "").toLowerCase();
  let text = stream;
  if (encoding && encoding !== "identity") {
    const make = DECOMPRESS[encoding];
    if (!make) return;
    text = stream.pipe(make());
    text.on("error", () => {});
  }
  let model = null;
  let usage = null;
  let content = [];
  let sse = false;
  let pending = "";
  const whole = [];
  const onLine = (line) => {
    if (!line.startsWith("data:")) return;
    sse = true;
    try {
      const event = JSON.parse(line.slice(5));
      if (event.type === "message_start") {
        model = event.message?.model ?? model;
        usage = { ...event.message?.usage };
      } else if (event.type === "message_delta" && event.usage) {
        usage = { ...usage, ...event.usage };
      } else if (event.type === "content_block_start") {
        content[event.index] = { ...event.content_block };
      } else if (event.type === "content_block_delta") {
        const b = content[event.index];
        const d = event.delta ?? {};
        if (!b) return;
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta") b.partial = (b.partial ?? "") + d.partial_json;
      } else if (event.type === "content_block_stop") {
        const b = content[event.index];
        if (b && "partial" in b) {
          try {
            b.input = b.partial ? JSON.parse(b.partial) : (b.input ?? {});
          } catch {
            // Leave the input as it started.
          }
          delete b.partial;
        }
      }
    } catch {
      // A partial or non-JSON line; usage is best effort.
    }
  };
  text.on("data", (chunk) => {
    const s = chunk.toString("utf8");
    if (!sse && whole.length < 64) whole.push(s);
    pending += s;
    const lines = pending.split("\n");
    pending = lines.pop();
    lines.forEach(onLine);
  });
  text.on("end", () => {
    onLine(pending);
    if (!sse) {
      try {
        const body = JSON.parse(whole.join(""));
        model = body.model;
        usage = body.usage;
        content = body.content ?? [];
      } catch {
        return;
      }
    }
    if (model && usage) onUsage(model, usage, content);
  });
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


export async function startProxy({ upstreamURL = ANTHROPIC_BASE_URL, route = askJev } = {}) {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const catalog = new Map();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      // A conversation resumed after a restart picks up where the last process left it.
      const saved = readConversation(key);
      s = { tier: null, ...(saved && { tier: saved.tier, model: saved.model, promptTokens: saved.promptTokens, warm: saved.warm }) };
      convos.set(key, s);
    }
    return s;
  };
  // Per conversation: advisor consultations from its responses, to restore into its history.
  const advice = new Map();
  const adviceFor = (key) => {
    if (!advice.has(key)) {
      if (advice.size > 50) advice.delete(advice.keys().next().value);
      advice.set(key, readAdvice(key));
    }
    return advice.get(key);
  };
  const saveState = (key, s) =>
    writeConversation(key, { tier: s.tier, model: s.model, promptTokens: s.promptTokens, warm: s.warm, at: Date.now() });

  // Per session: the main conversation's key, whether the user has picked a model by hand,
  // and running usage totals.
  const mains = new Map();
  const manual = new Set();
  const totals = new Map();

  /**
   * Picks the model for one request and rewrites the body to it. `ceiling` is the concrete
   * model a sub-agent asked for; routing never goes above its tier.
   */
  async function routeRequest(body, { key, session, isMain, ceiling, counting = false }) {
    const state = stateFor(key);
    const ceilingTier = ceiling ? tierOf(ceiling) : null;
    // What the prompt cache was built on, which is what a downgrade would discard. A new
    // sub-agent starts from the model it asked for.
    const current = state.tier ?? ceilingTier ?? "opus";
    const prompt = newTurnPrompt(body);
    const explaining = prompt?.includes("<cj-explain>");
    let fresh = null;
    if (prompt && !explaining) {
      const models = claudeModels([...catalog.values()]).filter((model) =>
        availableTiers().includes(model.tier),
      );
      const candidates = ceilingTier
        ? models.filter((model) => rankOf(model.tier) <= rankOf(ceilingTier))
        : models;
      const available = [...new Set(candidates.map((model) => model.tier))];
      const currentModel = state.model ?? ceiling ?? modelForTier(candidates, current);
      const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
      const history = recentContext(body);
      const jev = await route({
        prompt,
        current: currentModel,
        contextTokens,
        models: candidates,
        history,
        subagent: !isMain,
      });
      const chosen = candidates.find((model) => model.id === jev?.choice);
      const tierProbabilities = {};
      for (const [id, p] of Object.entries(jev?.probabilities ?? {})) {
        const t = candidates.find((model) => model.id === id)?.tier;
        if (t) tierProbabilities[t] = (tierProbabilities[t] ?? 0) + p;
      }
      const tierAnswer = jev && { ...jev, choice: chosen?.tier, tierProbabilities };
      let { tier, reason, enough } = decide({
        prompt,
        jev: tierAnswer,
        current,
        available,
        contextTokens,
        cache: cacheState(state, contextTokens),
      });
      if (ceilingTier && rankOf(tier) > rankOf(ceilingTier)) {
        tier = ceilingTier;
        reason = `${reason}+ceiling`;
      }
      const model =
        ceilingTier === tier
          ? ceiling
          : shouldUseExactModel(reason, chosen?.tier, tier)
            ? chosen.id
            : tier === current
              ? currentModel
              : modelForTier(candidates, tier);
      state.tier = tier;
      state.model = model;
      fresh = {
        prompt,
        model,
        requested: ceiling ?? null,
        confidence: jev?.confidence ?? null,
        enough: enough ?? null,
        metrics: jev?.metrics ?? null,
        newTask: jev?.newTask ?? null,
        fellShort: jev?.fellShort ?? null,
        contextTokens,
        reason,
        jev: jev ? { request: jev.request, response: jev.response } : null,
      };
      debug(
        `${key}${isMain ? "" : " sub-agent"} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
          `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
      );
    }
    // Every routed request is rewritten, including follow-ups that reuse the turn's model:
    // the sentinel is not a real model, and a sub-agent must stay on the model its turn chose.
    const tier = state.tier ?? current;
    const model = state.model ?? ceiling ?? idOf(tier);
    debug(`${key} rewrite ${body.model} -> ${model}`);
    applyTier(body, tier, model);
    // Only work routed below what was asked for gets the advisor: the main conversation asks
    // for the router's best (Opus), and a sub-agent that asked for Sonnet already has it.
    const advised = applyAdvisor(body, tier, ADVISOR.enabled() ? adviceFor(key) : [], {
      allowed: !counting && (!ceilingTier || rankOf(ceilingTier) > rankOf(tier)),
    });
    // Publish what went out. Claude Code's UI shows the row you picked, not the model it
    // resolved to, so the status line is the only place this is visible. `claude -p` omits
    // metadata on the first request of a session, so the decision is filed under the
    // conversation key, which is what `debug` prints and what `cj-explain` accepts.
    if (fresh) {
      const decision = { tier, ...fresh, at: Date.now() };
      if (isMain) writeDecision(session || key, decision);
      else writeSubagentDecision(session, decision);
    }
    return advised;
  }

  /**
   * Remembers, per conversation, the prompt size of its latest response and how much of it
   * each tier holds in its prompt cache, which is what a model switch would have to rebuild.
   */
  function noteCache(key, model, usage) {
    const tier = tierOf(model);
    if (!key || !tier) return;
    const state = stateFor(key);
    const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    state.promptTokens = cached + (usage.input_tokens ?? 0);
    // Claude Code asks for the 1-hour cache lifetime; a response written with the 5-minute
    // one says so in its usage.
    const ttl = usage.cache_creation?.ephemeral_5m_input_tokens > 0 ? 5 * 60000 : 60 * 60000;
    state.warm = { ...state.warm, [tier]: { tokens: cached, until: Date.now() + ttl } };
    saveState(key, state);
  }

  /** The cache state `decide` prices a model switch with. */
  function cacheState(state, contextTokens) {
    const warm = {};
    for (const [tier, w] of Object.entries(state.warm ?? {})) if (w.until > Date.now()) warm[tier] = w.tokens;
    return { promptTokens: Math.max(state.promptTokens ?? 0, contextTokens), warm };
  }

  /** Adds one response's usage to its session's totals and publishes them. */
  function recordUsage(sessionKey, model, usage) {
    const cost = costOf(model, usage);
    if (!cost) return;
    const t = totals.get(sessionKey) ?? { requests: 0, dollars: 0, tokens: {}, byModel: {} };
    t.requests++;
    t.dollars += cost.total;
    for (const [k, v] of Object.entries(cost.tokens)) t.tokens[k] = (t.tokens[k] ?? 0) + v;
    t.byModel[model] = (t.byModel[model] ?? 0) + cost.total;
    for (const a of advisorCosts(usage)) {
      t.dollars += a.cost.total;
      t.byModel[`${a.model} (advisor)`] = (t.byModel[`${a.model} (advisor)`] ?? 0) + a.cost.total;
      t.advice = (t.advice ?? 0) + 1;
    }
    t.at = Date.now();
    totals.set(sessionKey, t);
    writeUsage(sessionKey, t);
  }

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let usageKey = null;
      let convoKey = null;
      let advised = false;

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          const session = sessionOf(body);
          const key = conversationKey(body);
          const agentTurn = Array.isArray(body.tools) && body.tools.length > 0;
          // The first agent conversation in a session is the main one. Sub-agents run through
          // the same endpoint, each with its own opening message and so its own key. Compaction
          // replaces the main conversation's opening message with a summary, which changes its
          // key, so a conversation that opens with one takes over as main. Token counts are
          // not conversations and never claim it.
          const counting = /^\/v1\/messages\/count_tokens/.test(req.url ?? "");
          if (session && agentTurn && !counting && (!mains.has(session) || isContinuation(body))) {
            mains.set(session, key);
          }
          const isMain = !session || mains.get(session) === key;
          usageKey = session || key;
          convoKey = key;

          if (isAuto(body.model)) {
            if (isMain) manual.delete(session);
            advised = await routeRequest(body, { key, session, isMain, counting });
          } else if (!isMain && agentTurn && tierOf(body.model) && !manual.has(session)) {
            // A sub-agent asking for a concrete model: Claude or the agent's author picked it
            // as the strongest the task needs, so Jev may route the task down from it, never up.
            advised = await routeRequest(body, { key, session, isMain, ceiling: body.model, counting });
          } else {
            // Anything else is a model the user chose, and an explicit choice beats the
            // router. That also covers Claude Code's own cheap calls for titles and
            // summaries, which carry no tools and must never be pinned to the session's tier.
            debug(`passthrough, ${body.model} requested`);
            // Only the main conversation reflects the user's choice, and it pauses routing for
            // that session's sub-agents too.
            if (isMain && agentTurn) {
              manual.add(session);
              writeStatus(session, { manual: true, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (advised) {
        const betas = String(headers["anthropic-beta"] ?? "").split(",").map((b) => b.trim()).filter(Boolean);
        if (!betas.includes(ADVISOR.beta)) headers["anthropic-beta"] = [...betas, ADVISOR.beta].join(",");
      }
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (process.env.JEV_DEBUG) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          if (usageKey && up.statusCode === 200 && /^\/v1\/messages(?:\?|$)/.test(req.url ?? "")) {
            readResponseUsage(up, (model, usage, content) => {
              const records = advised ? adviceRecords(content) : [];
              if (records.length) {
                const list = adviceFor(convoKey);
                list.push(...records);
                if (list.length > 200) list.splice(0, list.length - 200);
                writeAdvice(convoKey, list);
                debug(`${convoKey} advisor consulted x${records.length}`);
              }
              if (advised) debug(`advisor usage ${JSON.stringify(usage.iterations ?? [])}`);
              recordUsage(usageKey, model, usage);
              noteCache(convoKey, model, usage);
            });
          }
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
