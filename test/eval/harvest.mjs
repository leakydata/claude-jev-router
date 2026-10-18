// Samples real prompts, with the conversation before each, from Claude Code's transcripts
// into a local file for labelling. Nothing is written inside the repository: these are the
// user's own prompts. usage: npm run eval:harvest [count] [days]
//
// Fill in each line's "tier" (haiku, sonnet, opus or fable: the cheapest that does the job
// in one pass) and optionally "newTask" (true or false), delete lines you don't want, then
// save the file as labelled.jsonl next to it for `npm run eval` to pick up.
import { readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { transcriptFiles } from "../../src/report.mjs";
import { newTurnPrompt } from "../../src/proxy.mjs";
import { LOCAL_SET } from "./paths.mjs";

const count = Number(process.argv[2] ?? 50);
const days = Number(process.argv[3] ?? 30);
const OUT = join(dirname(LOCAL_SET), "unlabelled.jsonl");
const PRIOR = 30;

// Tool results and file contents are cut down: routing reads the shape of earlier turns,
// not their bulk, and the file should stay small enough to label by hand.
const slim = (content) =>
  typeof content === "string"
    ? content.slice(0, 2000)
    : (content ?? [])
        .filter((b) => b.type !== "image" && b.type !== "thinking")
        .map((b) =>
          b.type === "tool_result"
            ? { ...b, content: typeof b.content === "string" ? b.content.slice(0, 500) : "[omitted]" }
            : b.type === "text"
              ? { ...b, text: b.text.slice(0, 2000) }
              : b,
        );

const candidates = [];
const files = transcriptFiles(undefined, Date.now() - days * 86400000).filter(
  (f) => !/[\\/]subagents[\\/]/.test(f),
);
for (const file of files) {
  // A transcript that large is mostly images and file contents; skip rather than load it.
  if (statSync(file).size > 300 * 1024 * 1024) continue;
  const messages = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith('{"') || !/"type":"(user|assistant)"/.test(line)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e.message;
    if (!m?.role) continue;
    const msg = { role: m.role, content: slim(m.content) };
    const prompt = m.role === "user" ? newTurnPrompt({ tools: [{}], messages: [msg] }) : null;
    if (prompt && !/^This session is being continued|^<command-|^Caveat:/.test(prompt)) {
      candidates.push({ tier: "", newTask: null, prompt, prior: messages.slice(-PRIOR) });
    }
    messages.push(msg);
  }
}

// A random sample, so labelling effort isn't spent on one long session.
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}
const sample = candidates.slice(0, count);
mkdirSync(dirname(OUT), { recursive: true, mode: 0o700 });
writeFileSync(OUT, sample.map((s) => JSON.stringify(s)).join("\n") + "\n", { mode: 0o600 });
console.log(`${sample.length} of ${candidates.length} prompts from the last ${days} days -> ${OUT}`);
console.log(`Label each "tier", then save it as ${LOCAL_SET}`);
