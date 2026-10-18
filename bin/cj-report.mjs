#!/usr/bin/env node
// Prints where Claude Code's tokens went: `cj-report` for the last 7 days, `cj-report 30` for
// the last 30.
import { formatReport, summarize, transcriptFiles } from "../src/report.mjs";

const days = Number(process.argv[2] ?? 7);
if (!(days > 0)) {
  process.stderr.write("usage: cj-report [days]\n");
  process.exit(1);
}
const since = Date.now() - days * 86400000;
const summary = await summarize(transcriptFiles(undefined, since), since);
process.stdout.write(`${formatReport(summary, days)}\n`);
