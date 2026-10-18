// Splits Claude Code transcripts into turns: one typed prompt, the work that followed it, and
// the user's next prompt. Shared by the eval harvester and the quality checks.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { newTurnPrompt } from "./proxy.mjs";

// A transcript that large is mostly images and file contents; skip rather than load it.
const MAX_FILE_BYTES = 300 * 1024 * 1024;

const SKIP_PROMPT = /^This session is being continued|^<command-|^<local-command|^Caveat:|^\[Request interrupted/;

/** Keeps the start and end of a long text, where the ask and the conclusion usually are. */
export const clip = (text, max) =>
  typeof text !== "string" || text.length <= max ? text : `${text.slice(0, max * 0.6)} […] ${text.slice(-max * 0.4)}`;

const resultText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : "";

// Tool results and file contents are cut down: what matters is the shape of a turn, not its
// bulk, and these files are read by Jev, by a judge model, and by hand.
const slim = (content) =>
  typeof content === "string"
    ? clip(content, 2000)
    : (content ?? [])
        .filter((b) => b.type !== "image" && b.type !== "thinking" && b.type !== "redacted_thinking")
        .map((b) =>
          b.type === "tool_result"
            ? { ...b, content: clip(resultText(b.content), 500) }
            : b.type === "text"
              ? { ...b, text: clip(b.text, 2000) }
              : b,
        );

const BIG_LINE = 256 * 1024;
// The delegation hook's note, which Claude Code records as a hook attachment on the prompt.
const HINT = "Claude Jev routing note";
const OPEN = Buffer.from('{"');

/**
 * The user and assistant entries of a transcript. Lines are split as bytes, and a very large
 * line, which is a screenshot, a file read or a file write, is not parsed: only the fields a
 * turn needs are picked out of its start, so a big transcript costs little more than its size.
 */
function* entries(buf) {
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl === -1) nl = buf.length;
    const line = buf.subarray(start, nl);
    start = nl + 1;
    if (!line.subarray(0, 2).equals(OPEN)) continue;
    if (line.length <= BIG_LINE) {
      const text = line.toString("utf8");
      if (!/"type":"(user|assistant)"/.test(text) && !text.includes(HINT)) continue;
      try {
        yield JSON.parse(text);
      } catch {
        // A partial line still being written.
      }
      continue;
    }
    const head = line.subarray(0, 4096).toString("utf8");
    const type = /"type":"(user|assistant)"/.exec(head)?.[1];
    if (!type) continue;
    const field = (name) => new RegExp(`"${name}":"([^"]*)"`).exec(head)?.[1];
    const errors = line.toString("latin1").match(/"is_error":true/g)?.length ?? 0;
    const content =
      type === "user"
        ? [{ type: "tool_result", is_error: errors > 0, content: "[large result]" }]
        : [{ type: "tool_use", name: /"type":"tool_use"[^}]*?"name":"([^"]+)"/.exec(head)?.[1] ?? "?", input: {} }];
    yield {
      type,
      uuid: field("uuid"),
      timestamp: field("timestamp"),
      message: { role: type, model: field("model"), id: /"message":\{[^}]*?"id":"([^"]+)"/.exec(head)?.[1], content },
    };
  }
}

/**
 * Reads one transcript into turns. Each turn has the prompt, the conversation before it
 * (slimmed, at most `prior` messages), the models that served it with their request counts,
 * the tool calls made, the final reply, the next prompt in the same conversation, and the
 * delegation hint's probability when the prompt hook added one.
 */
export function readTurns(file, { prior = 30 } = {}) {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return [];
  } catch {
    return [];
  }
  const subagent = /[\\/]subagents[\\/]/.test(file);
  const session = basename(file, ".jsonl");
  const messages = [];
  const turns = [];
  let turn = null;
  const seenRequests = new Set();
  for (const e of entries(readFileSync(file))) {
    if (e.type === "attachment") {
      const note = [].concat(e.attachment?.content ?? []).find((c) => typeof c === "string" && c.includes(HINT));
      if (turn && note) turn.hint = Number(/\(p=([\d.]+)\)/.exec(note)?.[1] ?? 1);
      continue;
    }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const m = e.message;
    if (!m?.role) continue;
    const msg = { role: m.role, content: slim(m.content) };
    if (m.role === "user" && !e.isMeta) {
      const prompt = newTurnPrompt({ tools: [{}], messages: [msg] });
      if (prompt && !SKIP_PROMPT.test(prompt)) {
        if (turn) turn.next = prompt;
        turn = {
          id: `${session}:${e.uuid}`,
          session,
          subagent,
          at: Date.parse(e.timestamp) || 0,
          prompt,
          prior: messages.slice(-prior),
          models: {},
          requests: 0,
          tools: [],
          toolErrors: 0,
          results: [],
          reply: "",
          next: null,
          hint: null,
        };
        turns.push(turn);
      }
    }
    if (turn && m.role === "assistant") {
      if (m.model && m.model !== "<synthetic>" && m.id && !seenRequests.has(m.id)) {
        seenRequests.add(m.id);
        turn.models[m.model] = (turn.models[m.model] ?? 0) + 1;
        turn.requests++;
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "tool_use") turn.tools.push({ name: b.name, input: clip(JSON.stringify(b.input ?? {}), 300) });
        else if (b.type === "text" && b.text.trim()) turn.reply = clip(b.text.trim(), 3000);
      }
    }
    if (turn && m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        if (b.is_error) turn.toolErrors++;
        if (turn.results.length < 40) turn.results.push({ error: !!b.is_error, text: clip(resultText(b.content), 300) });
      }
    }
    messages.push(msg);
  }
  return turns;
}

/** The model that served most of a turn's requests, or null for a turn with no reply. */
export function mainModel(turn) {
  const ranked = Object.entries(turn.models).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}
