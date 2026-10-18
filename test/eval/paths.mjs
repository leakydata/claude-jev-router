import { homedir } from "node:os";
import { join } from "node:path";

/** The user's own labelled prompts. Kept outside the repository: they are private. */
export const LOCAL_SET = join(homedir(), ".cache", "claude-jev", "eval", "labelled.jsonl");
