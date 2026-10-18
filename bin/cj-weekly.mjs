#!/usr/bin/env node
// cj-weekly              write this week's cost and quality summary, and notify
// cj-weekly --install    run it every Monday morning with a systemd user timer
// cj-weekly --uninstall  remove the timer
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, summarize, transcriptFiles } from "../src/report.mjs";
import { formatHints, formatScan, hints, scan, weeklyWarning } from "../src/quality.mjs";

const OUT_DIR = join(homedir(), ".cache", "claude-jev", "weekly");
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT = "cj-weekly";

const systemctl = (...args) => execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });

if (process.argv.includes("--install")) {
  mkdirSync(UNIT_DIR, { recursive: true });
  const script = fileURLToPath(import.meta.url);
  writeFileSync(
    join(UNIT_DIR, `${UNIT}.service`),
    `[Unit]\nDescription=Claude Jev weekly cost and quality check\n\n[Service]\nType=oneshot\nExecStart="${process.execPath}" "${script}"\n`,
  );
  // Persistent: a Monday the machine was off runs at the next start instead.
  writeFileSync(
    join(UNIT_DIR, `${UNIT}.timer`),
    `[Unit]\nDescription=Run the Claude Jev weekly check\n\n[Timer]\nOnCalendar=Mon *-*-* 09:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  );
  systemctl("daemon-reload");
  systemctl("enable", "--now", `${UNIT}.timer`);
  console.log(`Installed: every Monday at 09:00, summaries in ${OUT_DIR}`);
  process.exit(0);
}
if (process.argv.includes("--uninstall")) {
  try {
    systemctl("disable", "--now", `${UNIT}.timer`);
  } catch {
    // Not installed.
  }
  rmSync(join(UNIT_DIR, `${UNIT}.service`), { force: true });
  rmSync(join(UNIT_DIR, `${UNIT}.timer`), { force: true });
  systemctl("daemon-reload");
  console.log("Removed the weekly timer.");
  process.exit(0);
}

try {
  process.loadEnvFile(join(homedir(), ".claude-jev.env"));
} catch {
  // The key may already be in the environment.
}

const DAYS = 7;
const since = Date.now() - DAYS * 86400000;
const report = await summarize(transcriptFiles(undefined, since), since);
const sections = [formatReport(report, DAYS)];
let warning = null;
if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
  const s = await scan(DAYS);
  warning = weeklyWarning(s);
  sections.push(formatScan(s));
} else {
  sections.push("Quality scan skipped: no JEV_API_KEY in ~/.claude-jev.env.");
}
sections.push(formatHints(hints(DAYS)));
if (warning) sections.unshift(`WARNING: ${warning}`);

const day = new Date().toLocaleDateString("sv");
mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const file = join(OUT_DIR, `${day}.txt`);
const text = sections.join("\n\n");
writeFileSync(file, `${text}\n`, { mode: 0o600 });
writeFileSync(join(OUT_DIR, "latest.json"), JSON.stringify({ at: Date.now(), file, warning }), { mode: 0o600 });
console.log(text);

const summary = `$${report.total.dollars.toFixed(0)} this week at list prices${warning ? `. ${warning}` : ""}. Full report: ${file}`;
try {
  execFileSync("notify-send", [
    "--app-name=Claude Jev",
    `--urgency=${warning ? "critical" : "normal"}`,
    warning ? "Claude Jev: routing may be costing quality" : "Claude Jev weekly check",
    summary,
  ]);
} catch {
  // No notification daemon, as in a plain terminal session; the file is the record.
}
