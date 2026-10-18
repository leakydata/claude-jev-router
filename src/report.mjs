// Where Claude Code's tokens went, from the session transcripts it already keeps. Every API
// response is recorded there with its served model and usage, so this needs no logging of
// its own and covers plain `claude` sessions as well as routed ones.
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { costOf, advisorCosts } from "./pricing.mjs";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");
export const CACHE_FILE = join(homedir(), ".cache", "claude-jev", "report.json");
const CACHE_VERSION = 3;

/** Transcript files modified since `since` (ms), main sessions and sub-agents alike. */
export function transcriptFiles(root = PROJECTS_DIR, since = 0) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          if (statSync(path).mtimeMs >= since) files.push(path);
        } catch {
          // Removed while walking.
        }
      }
    }
  };
  walk(root);
  return files;
}

const COMPONENTS = ["cache_read", "cache_write", "input", "output"];
const zeros = () => Object.fromEntries(COMPONENTS.map((k) => [k, 0]));
const bucket = () => ({ requests: 0, dollars: zeros(), tokens: zeros() });

/**
 * Folds the transcript lines after `entry.offset` into `entry.days`, a per-day, per-model
 * tally. Transcripts are append-only, so a file only ever needs its new tail read. A
 * trailing line without a newline may still be being written; it is left for the next run.
 */
const USAGE = Buffer.from('"usage"');
const COMPACT = Buffer.from("compact_boundary");

async function scanFile(path, entry) {
  let offset = entry.offset;
  const onLine = (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const at = Date.parse(e.timestamp ?? "");
    if (!Number.isFinite(at)) return;
    const day = new Date(at).toLocaleDateString("sv");
    const d = (entry.days[day] ??= { compactions: 0, models: {} });
    if (e.type === "system" && e.subtype === "compact_boundary") {
      d.compactions++;
      return;
    }
    const m = e.message;
    if (e.type !== "assistant" || !m?.usage) return;
    // One response is written as several entries that repeat its usage, sometimes with tool
    // results between them, so remember the last few ids rather than just the previous one.
    // Sub-agent transcripts can write the first entry mid-stream, with the output count so
    // far, so a later entry with more output adds the difference.
    const id = m.id ?? e.requestId;
    const cost = costOf(m.model, m.usage);
    if (!cost) return;
    const b = (d.models[m.model] ??= bucket());
    const seen = id ? entry.recent.find((r) => r[0] === id) : null;
    if (seen) {
      const more = cost.tokens.output - seen[1];
      if (more > 0) {
        b.tokens.output += more;
        b.dollars.output += (cost.dollars.output * more) / cost.tokens.output;
        seen[1] = cost.tokens.output;
      }
      return;
    }
    if (id) entry.recent = [...entry.recent.slice(-31), [id, cost.tokens.output]];
    b.requests++;
    for (const k of COMPONENTS) {
      b.dollars[k] += cost.dollars[k];
      b.tokens[k] += cost.tokens[k];
    }
    // Advisor consultations are another model's tokens, so they get a row of their own.
    for (const a of advisorCosts(m.usage)) {
      const ab = (d.models[`${a.model} (advisor)`] ??= bucket());
      ab.requests++;
      for (const k of COMPONENTS) {
        ab.dollars[k] += a.cost.dollars[k];
        ab.tokens[k] += a.cost.tokens[k];
      }
    }
  };
  // Lines are split as bytes and only decoded when they can hold usage: transcripts carry
  // multi-megabyte lines (screenshots, file contents) that would otherwise be re-joined as
  // text on every chunk.
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: offset, highWaterMark: 1 << 20 });
    let parts = [];
    stream.on("data", (chunk) => {
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, nl);
        const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
        parts = [];
        offset += line.length + 1;
        if (line.includes(USAGE) || line.includes(COMPACT)) onLine(line.toString("utf8"));
        start = nl + 1;
      }
      if (start < chunk.length) parts.push(chunk.subarray(start));
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  entry.offset = offset;
}

function loadCache(file) {
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    if (cache.version === CACHE_VERSION) return cache;
  } catch {
    // Missing or unreadable: start over.
  }
  return { version: CACHE_VERSION, files: {} };
}

/**
 * Totals every priced API response on or after the calendar day of `since` (ms): overall,
 * per component, per model, per day, and for sub-agents, plus compactions.
 */
export async function summarize(files, since = 0, { cacheFile = CACHE_FILE } = {}) {
  const cache = cacheFile ? loadCache(cacheFile) : { files: {} };
  for (const path of files) {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    let entry = cache.files[path];
    // A file smaller than what was read before was replaced, not appended to.
    if (!entry || size < entry.offset) entry = cache.files[path] = { offset: 0, recent: [], days: {} };
    if (size > entry.offset) await scanFile(path, entry);
  }
  if (cacheFile) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      // The report still works without the cache, just slower next time.
    }
  }

  const first = new Date(since).toLocaleDateString("sv");
  const total = { requests: 0, dollars: 0, tokens: zeros() };
  const components = zeros();
  const byModel = {};
  const byDay = {};
  const subagents = { requests: 0, dollars: 0 };
  let compactions = 0;
  for (const path of files) {
    const subagent = /[\\/]subagents[\\/]/.test(path);
    for (const [day, d] of Object.entries(cache.files[path]?.days ?? {})) {
      if (day < first) continue;
      compactions += d.compactions;
      for (const [model, b] of Object.entries(d.models)) {
        const dollars = COMPONENTS.reduce((sum, k) => sum + b.dollars[k], 0);
        total.requests += b.requests;
        total.dollars += dollars;
        for (const k of COMPONENTS) {
          total.tokens[k] += b.tokens[k];
          components[k] += b.dollars[k];
        }
        const mm = (byModel[model] ??= { requests: 0, dollars: 0 });
        mm.requests += b.requests;
        mm.dollars += dollars;
        const dd = (byDay[day] ??= { requests: 0, dollars: 0, context: 0 });
        dd.requests += b.requests;
        dd.dollars += dollars;
        dd.context += b.tokens.cache_read + b.tokens.cache_write + b.tokens.input;
        if (subagent) {
          subagents.requests += b.requests;
          subagents.dollars += dollars;
        }
      }
    }
  }
  return { total, components, byModel, byDay, subagents, compactions };
}

const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");
const tokensK = (n) => `${Math.round(n / 1000).toLocaleString("en-US")}k`;
const count = (n) => n.toLocaleString("en-US");
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/** Plain-text report for a terminal. */
export function formatReport(s, days) {
  const t = s.total;
  if (!t.requests) return `No priced Claude API responses in the last ${days} days.`;
  const inputSide = t.tokens.cache_read + t.tokens.cache_write + t.tokens.input;
  const out = [
    `Claude Code usage, last ${days} days (API list prices; a subscription is not billed this way)`,
    "",
    `  total ${money(t.dollars)} over ${count(t.requests)} requests, ${money(t.dollars / days)}/day`,
    `  average context per request ${tokensK(inputSide / t.requests)} tokens, ` +
      `cache hit rate ${pct(t.tokens.cache_read, inputSide)}`,
    `  sub-agents ${money(s.subagents.dollars)} (${pct(s.subagents.dollars, t.dollars)}), ` +
      `compactions ${s.compactions}`,
    "",
    "  by component",
  ];
  for (const [k, v] of Object.entries(s.components).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${pad(k.replace("_", " "), 12)} ${lpad(money(v), 11)}  ${lpad(pct(v, t.dollars), 6)}`);
  }
  out.push("", "  by model");
  for (const [k, v] of Object.entries(s.byModel).sort((a, b) => b[1].dollars - a[1].dollars)) {
    out.push(
      `    ${pad(k, 28)} ${lpad(money(v.dollars), 11)}  ${lpad(pct(v.dollars, t.dollars), 6)}  ` +
        `${lpad(count(v.requests), 7)} requests`,
    );
  }
  out.push("", "  by day                         cost   requests  avg context");
  for (const [day, v] of Object.entries(s.byDay).sort()) {
    out.push(
      `    ${pad(day, 12)} ${lpad(money(v.dollars), 16)} ${lpad(count(v.requests), 10)} ` +
        `${lpad(tokensK(v.context / v.requests), 12)}`,
    );
  }
  return out.join("\n");
}
