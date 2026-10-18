// Hand-labelled routing scenarios, all synthetic. `tier` is the cheapest tier that should do
// the work in one pass; `newTask` is whether the prompt needs nothing from the conversation;
// `fellShort` is whether the prompt says the previous turn failed, and `servedOn` the tier
// that turn ran on (Opus when absent), which a miss steps up from.
// Real prompts belong in the local, unpublished file `npm run eval:harvest` writes.

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text, tools = []) => ({
  role: "assistant",
  content: [{ type: "text", text }, ...tools.map(([name, input], i) => ({ type: "tool_use", id: `t${i}${name}`, name, input }))],
});
const results = (tools, isError = false) => ({
  role: "user",
  content: tools.map(([name], i) => ({ type: "tool_result", tool_use_id: `t${i}${name}`, content: "ok", is_error: isError })),
});

const websocket = [
  user("Our websocket server drops messages under load and I can't reproduce it locally. Investigate."),
  reply(
    "I traced it to a race between the reconnect handler and the send queue flush: when a client reconnects while a flush is in progress, two writers share the buffer. The fix needs a per-connection lock and an ordering guarantee across the reconnect, touching server.ts, queue.ts and session.ts. Want me to implement it?",
    [["Read", { file_path: "src/server.ts" }], ["Grep", { pattern: "flush" }]],
  ),
  results([["Read"], ["Grep"]]),
];

const fixedRace = [
  user("Our websocket server drops messages under load. Investigate."),
  reply("It's a race between reconnect and the send-queue flush in src/queue.ts. I added a per-connection lock; tests pass."),
];

const sonnetFix = [
  user("the CSV export drops rows that contain a comma in the name field, fix it"),
  reply("Fixed: names are now quoted when they contain a comma. Tests pass.", [["Edit", { file_path: "src/export.ts" }], ["Bash", { command: "npm test" }]]),
  results([["Edit"], ["Bash"]]),
];

export const SCENARIOS = [
  { tier: "haiku", prompt: "fix the typo 'recieve' in README.md" },
  { tier: "haiku", prompt: "what does git status say?" },
  { tier: "haiku", prompt: "write a commit message for the staged changes" },
  { tier: "sonnet", prompt: "add a unit test for the existing formatDate helper" },
  { tier: "sonnet", prompt: "add a --verbose flag to the CLI that prints each file as it is processed" },
  { tier: "opus", prompt: "users intermittently get logged out after deploy, figure out why" },
  { tier: "opus", prompt: "design the permission model for multi-tenant workspaces and wire it through the API" },
  { tier: "opus", newTask: false, prompt: "yes, go ahead", prior: websocket },
  {
    tier: "opus",
    newTask: false,
    prompt: "still failing, try again",
    prior: [
      user("migrate the user table to split name into first_name and last_name without downtime"),
      reply("I wrote a three-phase migration with a dual-write trigger.", [
        ["Write", { file_path: "migrations/0042_split_name.sql" }],
        ["Edit", { file_path: "src/db/user.ts" }],
        ["Bash", { command: "npm test" }],
      ]),
      results([["Write"], ["Edit"], ["Bash"]], true),
      reply("The backfill deadlocks against the trigger on concurrent updates; tests fail with deadlock detected."),
    ],
  },
  {
    tier: "haiku",
    newTask: false,
    prompt: "ok thanks, commit it",
    prior: [
      user("rename the variable tmp to buffer in src/util.ts"),
      reply("Renamed tmp to buffer in src/util.ts (3 occurrences).", [["Edit", { file_path: "src/util.ts" }]]),
      results([["Edit"]]),
    ],
  },
  {
    tier: "sonnet",
    newTask: false,
    prompt: "do the same for the other two endpoints",
    prior: [
      user("add input validation with zod to the POST /orders endpoint"),
      reply("Added a zod schema and validation middleware to POST /orders, with tests.", [
        ["Edit", { file_path: "src/routes/orders.ts" }],
        ["Write", { file_path: "test/orders.test.ts" }],
      ]),
      results([["Edit"], ["Write"]]),
    ],
  },
  {
    tier: "haiku",
    newTask: false,
    prompt: "what was the file you changed?",
    prior: [
      user("the login page throws on submit when the email is empty, fix it"),
      reply("Fixed: the handler read email.trim() before checking for null. Changed src/login.tsx.", [["Edit", { file_path: "src/login.tsx" }]]),
      results([["Edit"]]),
    ],
  },
  {
    tier: "haiku",
    newTask: false,
    prompt: "yes",
    prior: [user("bump the version in package.json to 1.4.0"), reply("Want me to bump it from 1.3.2 to 1.4.0?")],
  },
  { tier: "haiku", newTask: false, prompt: "what time did the deadlock first show up in that log?", prior: websocket },
  { tier: "sonnet", newTask: false, prompt: "now add a test for the reconnect path", prior: fixedRace },
  { tier: "opus", newTask: false, prompt: "does the same race exist in the http long-poll fallback?", prior: fixedRace },
  { tier: "haiku", newTask: true, prompt: "unrelated: write me a bash one-liner to find files over 1GB in my home dir", prior: fixedRace },
  { tier: "sonnet", newTask: true, prompt: "set up a new vite + react project in ~/code/dashboard", prior: fixedRace },
  { tier: "opus", newTask: true, prompt: "my bluetooth headphones connect but play no audio on kubuntu, find out why and fix it", prior: fixedRace },
  { tier: "opus", servedOn: "sonnet", newTask: false, fellShort: true, prompt: "no, rows with a quote character in the name still come out broken, and now the header is quoted too", prior: sonnetFix },
  { tier: "opus", servedOn: "sonnet", newTask: false, fellShort: true, prompt: "that's not what I asked, I wanted the export to skip rows with empty names", prior: sonnetFix },
  { tier: "haiku", newTask: false, fellShort: false, prompt: "great, commit it", prior: sonnetFix },
  { tier: "sonnet", newTask: false, fellShort: false, prompt: "nice, now add the same quoting to the JSON-lines export", prior: sonnetFix },
];
