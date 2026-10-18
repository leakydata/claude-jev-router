#!/usr/bin/env node
// cj-quality scan [days]          Jev reads each turn's follow-up for signs the turn fell short
// cj-quality judge [count] [days] Opus grades turns and labels the model each one needed
import { homedir } from "node:os";
import { join } from "node:path";
import { formatJudged, formatScan, judge, scan } from "../src/quality.mjs";

try {
  process.loadEnvFile(join(homedir(), ".claude-jev.env"));
} catch {
  // The key may already be in the environment.
}

const [command, a, b] = process.argv.slice(2);
const progress = (label) => (done, total) => {
  if (process.stderr.isTTY) process.stderr.write(`\r${label} ${done}/${total}`);
};

if (command === "scan") {
  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
    console.error("cj-quality scan needs JEV_API_KEY (in ~/.claude-jev.env)");
    process.exit(1);
  }
  const s = await scan(Number(a ?? 14), { onProgress: progress("asking Jev") });
  if (process.stderr.isTTY) process.stderr.write("\n");
  console.log(formatScan(s));
} else if (command === "judge") {
  const run = await judge(Number(a ?? 40), Number(b ?? 14), { onProgress: progress("judging") });
  if (process.stderr.isTTY) process.stderr.write("\n");
  console.log(formatJudged(run));
} else {
  console.log(
    "usage:\n" +
      "  cj-quality scan [days]           how often each model's turns needed correcting (Jev, ~free)\n" +
      "  cj-quality judge [count] [days]  Opus labels the model each turn needed (uses your Claude login)",
  );
  process.exit(command ? 1 : 0);
}
