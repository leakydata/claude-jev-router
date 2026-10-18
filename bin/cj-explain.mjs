#!/usr/bin/env node
import { readStatus } from "../src/status.mjs";
import { formatExplanation } from "../src/explain.mjs";

process.stdout.write(`${formatExplanation(readStatus(process.argv[2]))}\n`);
