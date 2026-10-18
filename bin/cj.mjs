#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { AUTO_MODEL, DEFAULT_COMPACT_WINDOW } from "../src/config.mjs";
import { readSavedModel, restoreSavedModel, seedCompactWindow } from "../src/settings.mjs";
import { LOG_FILE } from "../src/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * Registers "Claude Jev" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Claude Jev",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
  };
  // Defaults the user can override by setting the variable themselves.
  const defaults = {
    // Claude Code assumes a 200K window for a model id it does not recognise. Every routed
    // model has a 1M window, and declaring it keeps proactive and idle compaction running at
    // the window the user chose. The sentinel must not start with "claude-" for this to apply.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    // Claude Code turns MCP tool search off behind a custom base URL, because most proxies
    // drop `tool_reference` blocks. This proxy forwards them untouched, so MCP tool
    // definitions can stay deferred instead of being re-read on every request.
    ENABLE_TOOL_SEARCH: "true",
  };
  for (const [key, value] of Object.entries(defaults)) if (!process.env[key]) env[key] = value;
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  return env;
}

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

const node = (script) => `"${process.execPath}" "${join(HERE, script)}"`;

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLine() {
  if (process.env.JEV_NO_STATUSLINE) return null;
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return null;
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  return { type: "command", command: node("cj-statusline.mjs") };
}

/**
 * The prompt hook that suggests a sub-agent for bulky, self-contained gathering. It runs
 * through Claude Code so its note is recorded in the conversation like any hook output,
 * rather than being spliced into requests where it would break the prompt cache. Hooks from
 * `--settings` are added to the user's own.
 */
function delegationHook() {
  if (process.env.CJ_NO_DELEGATION_HINT) return null;
  return { UserPromptSubmit: [{ hooks: [{ type: "command", command: node("cj-hook.mjs"), timeout: 5 }] }] };
}

function settingsArgs() {
  const settings = {};
  const line = statusLine();
  if (line) settings.statusLine = line;
  const hooks = delegationHook();
  if (hooks) settings.hooks = hooks;
  if (!Object.keys(settings).length) return [];
  // Passed as a file rather than inline JSON: on Windows the args go through a shell, and a
  // JSON string containing its own quotes does not survive that. One file per launch, since
  // sessions started from different directories can differ.
  const file = join(tmpdir(), "claude-jev", `settings-${process.pid}.json`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(settings));
  } catch {
    return [];
  }
  return ["--settings", file];
}

// Existing environment variables win, followed by the project-local file, then the user's.
for (const file of [join(process.cwd(), ".env"), join(homedir(), ".claude-jev.env")]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing or unreadable; the key may still come from the real environment.
  }
}

/**
 * Finds the Claude Code executable on PATH. Resolving it here rather than leaning on the
 * shell means arguments are passed as an array (no quoting hazard, no DEP0190 warning) and
 * a missing install produces a useful message instead of a shell error. Older npm-based
 * installs are a `.cmd` shim, which Node still refuses to run without a shell.
 */
function resolveClaude() {
  const win = process.platform === "win32";
  const exts = win ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `claude${ext}`);
      try {
        accessSync(file, constants.X_OK);
        return { file, shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

const args = process.argv.slice(2);
args.push("--add-dir", ROOT);
const env = { ...process.env };

const claude = resolveClaude();
if (!claude) {
  process.stderr.write(
    "[jev] Claude Code is not installed, or `claude` is not on your PATH.\n" +
      "[jev] claude-jev runs the real Claude Code CLI; install it first:\n" +
      "[jev]   https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
  const { port, close } = await startProxy();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  Object.assign(env, autoModelEnv());
  seedCompactWindow(DEFAULT_COMPACT_WINDOW);
  process.on("exit", () => {
    close();
    restoreSavedModel(savedModelBefore);
  });
  args.push(...settingsArgs());
  if (process.env.JEV_DEBUG && process.stdout.isTTY) {
    process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  }
} else {
  process.stderr.write(
    `[jev] no JEV_API_KEY found - starting Claude Code without routing\n` +
      `[jev] set it in ${join(homedir(), ".claude-jev.env")} to enable routing\n`,
  );
}

// On Windows a `.cmd` shim still needs a shell; a real executable does not.
const child = spawn(claude.file, claude.shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
  stdio: "inherit",
  shell: claude.shell,
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[jev] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
