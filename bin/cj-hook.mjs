#!/usr/bin/env node
// Claude Code UserPromptSubmit hook. Asks Jev whether the prompt is bulky, self-contained
// gathering (searching, reading or browsing a lot for a short answer) and, if so, adds a note
// suggesting Claude hand it to a sub-agent, so only the conclusion lands in the main
// conversation instead of being re-read on every later request. It never blocks a prompt:
// any failure prints nothing and exits 0.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { askDelegation } from "../src/router.mjs";
import { recentContext } from "../src/proxy.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const TAIL_BYTES = 4 * 1024 * 1024;

/** The conversation so far, as API-shaped messages, from the end of the transcript file. */
function transcriptMessages(path) {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    readSync(fd, buf, 0, length, size - length);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    if (length < size) lines.shift(); // the first line is cut off
    const messages = [];
    for (const line of lines) {
      if (!/"type":"(user|assistant)"/.test(line)) continue;
      try {
        const m = JSON.parse(line).message;
        if (m?.role) messages.push({ role: m.role, content: m.content });
      } catch {
        // A partial line.
      }
    }
    return messages;
  } catch {
    return [];
  }
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = input.prompt?.trim();
  if (prompt && !prompt.startsWith("/")) {
    const messages = [...transcriptMessages(input.transcript_path), { role: "user", content: prompt }];
    const p = await askDelegation({ prompt, history: recentContext({ messages }) });
    if (p >= THRESHOLDS.delegateProbability) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              `Claude Jev routing note (p=${p.toFixed(2)}): this request looks like self-contained ` +
              "gathering: searching, reading or browsing a lot of material where only the conclusion " +
              "matters afterwards. Consider handing the bulk of it to a sub-agent with the Agent tool " +
              "and keeping only its findings here; the router picks the sub-agent's model. Ignore this " +
              "if the work needs details from this conversation or produces changes you should make here.",
          },
        }),
      );
    }
  }
} catch {
  // Never get in the way of a prompt.
}
