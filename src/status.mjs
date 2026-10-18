import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One file per session rather than a shared map, so concurrent claude-jev sessions can never
// clobber each other's status. Kept in the temp dir so the OS eventually cleans up.
const DIR = join(tmpdir(), "claude-jev");

// Status files hold prompt text and exact Jev exchanges, so only the owner may read them.
// On Linux the temp dir is the shared /tmp; macOS and Windows temp dirs are already per-user,
// where these modes are harmless (Windows ignores them).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Files not updated for this long belong to finished sessions and are removed.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
let pruned = false;

const fileFor = (sessionId) => join(DIR, `${sessionId.replace(/[^\w-]/g, "")}.json`);

/** Publish the latest routing decision so the status line can display it. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    ensureDir();
    const file = fileFor(sessionId);
    writeFileSync(file, JSON.stringify(status), { mode: FILE_MODE });
    // `mode` only applies on creation; tighten files written by earlier versions too.
    chmodSync(file, FILE_MODE);
    if (!pruned) {
      pruned = true;
      pruneStale();
    }
  } catch {
    // Status display is cosmetic and must never interfere with a request.
  }
}

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
}

/**
 * Record a sub-agent's routing decision in the session's history without replacing the main
 * conversation's latest decision, which is what the status line shows.
 */
export function writeSubagentDecision(sessionId, decision) {
  const previous = readStatus(sessionId) ?? {};
  const history = [...(previous.history ?? []), { ...decision, subagent: true }].slice(-20);
  writeStatus(sessionId, { ...previous, history });
}

/** Running token and cost totals for a session, kept apart from routing decisions. */
export const writeUsage = (sessionId, usage) => writeStatus(`${sessionId}-usage`, usage);

export const readUsage = (sessionId) => (sessionId ? readStatus(`${sessionId}-usage`) : null);

/**
 * A conversation's routed model and prompt-cache state, kept on disk so a restarted `cj`
 * resuming the conversation knows which model's cache is still warm. Keyed by conversation,
 * which is stable across restarts for the same session and opening message.
 */
export const writeConversation = (key, state) => writeStatus(`convo-${key}`, state);

export const readConversation = (key) => (key ? readStatus(`convo-${key}`) : null);

/** Advisor consultations seen in a conversation's responses, which Claude Code drops from history. */
export const writeAdvice = (key, records) => writeStatus(`advice-${key}`, { records });
export const readAdvice = (key) => (key ? (readStatus(`advice-${key}`)?.records ?? []) : []);

/** Latest routing decision for a session, or null if none has been made yet. */
export function readStatus(sessionId) {
  try {
    return JSON.parse(readFileSync(fileFor(sessionId), "utf8"));
  } catch {
    return null;
  }
}

function ensureDir() {
  mkdirSync(DIR, { recursive: true, mode: DIR_MODE });
  // Directories created by earlier versions were world-readable. chmod fails if another user
  // owns the directory, in which case the write below fails too and status is skipped.
  chmodSync(DIR, DIR_MODE);
}

/** Delete status files untouched for `maxAgeMs`. Runs once per process on the first write. */
export function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(DIR, name);
      try {
        if (now - statSync(file).mtimeMs > maxAgeMs) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        // Another session may have removed or replaced it; ignore.
      }
    }
  } catch {
    // Missing or unreadable directory: nothing to prune.
  }
  return removed;
}

/** Directory holding status files, exposed for tests and diagnostics. */
export const STATUS_DIR = DIR;
