# claude-jev-router

Automatic per-turn model routing for Claude Code. Jev sends simple work to Haiku and difficult
work to Opus, while preserving Claude Code's native interface, tools, sessions, permissions,
and authentication.

`cj` launches the real Claude Code CLI. Jev only chooses the model for a fresh user
turn, and the decision is shown in the status line.

A Claude-only fork of [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router).

## Quick start

Requires Node.js 20.12+ and [Claude Code](https://code.claude.com/docs/en/setup).

```bash
git clone https://github.com/leakydata/claude-jev-router.git
cd claude-jev-router
npm install
npm install -g .
echo "JEV_API_KEY=..." > ~/.claude-jev.env
```

`npm install -g .` links the global commands to this checkout, so edits take effect at the
next launch. Without it, run `node bin/cj.mjs`.

Get a key from [TypeSafe](https://docs.typesafe.ai). Then launch from any repository:

```bash
cj
```

No Anthropic API key is required when Claude Code is already logged in with a subscription.
Every CLI argument is forwarded:

```bash
cj --resume
cj -p "fix the failing test"
```

## Claude Code interface

![Claude Jev in the Claude Code model picker](docs/model-picker.png)

`cj` launches Claude Code with **Claude Jev** selected in `/model`. Selecting another
model pauses routing; selecting **Claude Jev** resumes it.

The injected status line shows the model used for the last turn:

```text
claude-haiku-5-5 (p=0.98) · my-project · 8% context
⏸ manual Opus 5.5 · my-project · 21% context
```

Claude Code otherwise remains unchanged, including its keybindings, tools, permission prompts,
`/compact`, `/resume`, and session handling. An existing custom `statusLine` is preserved;
set `JEV_NO_STATUSLINE=1` to disable Jev's status line.

The bundled `/cj-explain` skill shows the factors behind the last routing decision:

```text
┌─────────────────────────────────────────┐
│ Claude Jev                              │
│                                         │
│ Jev request                             │
│ Prompt: explain the router              │
│ Current tier: CLAUDE-HAIKU-5-5          │
│ Context tokens: 6200                    │
│                                         │
│ Jev response                            │
│ Task complexity     0.82                │
│ Reasoning required  0.91                │
│ Tool complexity     0.64                │
│ Context size        0.31                │
│                                         │
│ Recommended: CLAUDE-SONNET-5-5          │
│ Selected model: CLAUDE-SONNET-5-5       │
│                                         │
│ Confidence: 94%                         │
│ Decision: Jev recommendation            │
└─────────────────────────────────────────┘
```

The report is rendered locally from the exact prompt, System One request, and System One
response saved when routing occurred. Invoking it does not ask Jev to score the prompt again.

### Explanation data location

`cj` keeps up to 20 recent routing exchanges in one JSON file per Claude Code session
under Node.js's operating-system temporary directory:

| Platform | Default location |
| --- | --- |
| Windows | `%TEMP%\claude-jev\<session-id>.json` |
| macOS | `$TMPDIR/claude-jev/<session-id>.json` (normally under `/var/folders/.../T`) |
| Ubuntu/Linux | `${TMPDIR:-/tmp}/claude-jev/<session-id>.json` |

Print the exact directory selected on the current machine with:

```bash
node -e "console.log(require('node:path').join(require('node:os').tmpdir(), 'claude-jev'))"
```

Filenames use Claude Code's session UUID. These temporary files contain prompt text and Jev's
exact request and response, so they are readable only by you (the directory is created with
mode 700 and each file with 600). Files not updated for 7 days are deleted automatically, and
the operating system may also remove them during normal temporary-file cleanup.

> Choosing a model with `Enter` can save it as Claude Code's default. `cj` restores
> the previous default on exit so the `cj-auto` model id cannot break plain `claude`.

## How it works

`cj` starts a loopback proxy, points Claude Code at it with `ANTHROPIC_BASE_URL`, and
forwards Claude Code's existing authorization headers without reading, storing, or modifying
them.

```text
you -> Claude Code -> cj proxy -> Anthropic
                         |
                         +-> Jev: choose a model
```

`cj-auto` is the routing sentinel model id. Any concrete model selected by the user passes
through unchanged.

## Token savings

Every request re-reads the whole conversation from the prompt cache, so in long sessions the
size of the context, not the choice of model, decides the bill. Measured over two weeks of real
sessions, cache reads were 72% of the cost and output 6.5%. `cj` acts on that:

- **MCP tool search stays on.** Claude Code turns tool search off behind a custom
  `ANTHROPIC_BASE_URL`; `cj` sets `ENABLE_TOOL_SEARCH=true`, so MCP tool definitions load on
  demand instead of riding along on every request. On one machine this cut the tool
  definitions in the first request from about 144K tokens to about 7K.
- **Compaction works, at 400K.** `cj` declares the routed models' 1M window
  (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) so Claude Code's proactive and idle compaction run, and
  seeds an auto-compact window of 400K the first time it starts. Replaying two weeks of
  sessions, Claude Code's own ~967K threshold saved 1%, 600K saved 30%, 400K saved 43%, and
  lower windows added many more compactions for little more.
- **The model is picked per turn** by Jev, using the conversation so far.
- **New-task hint.** When Jev is confident a prompt starts a separate task and the conversation
  is over 100K tokens, the status line suggests `/clear` or `/compact`. Nothing happens unless
  you run one.

Compaction is your choice:

| You want | Do |
| --- | --- |
| A different window from now on | `/autocompact 600k` in a `cj` session |
| Claude Code's normal threshold from now on | `/autocompact auto` |
| A different window for one launch | `cj --autocompact 300k` |
| To compact or clear right now | `/compact` or `/clear` |

`cj` writes the 400K default only once, to `modelSettings["cj-auto"]` in
`~/.claude/settings.json`, which is the same place `/autocompact` saves to, so a choice you
make there sticks. Other models' settings are not touched.

## Routing policy

One Jev call per fresh user turn picks an exact model from the account's catalog. Jev sees the
new prompt, a bounded slice of the conversation before it, and per-model guidance in
`src/config.mjs`.

| Tier | Default model |
| --- | --- |
| Fast | `claude-haiku-5-5` |
| Balanced | `claude-sonnet-5-5` |
| Strong | `claude-opus-5-5` |
| Long | `claude-fable-5-1` |

`src/policy.mjs` then applies these rules:

- explicit requests such as `use opus`, `use haiku`, or `use strong` win;
- failure, timeout, or an unrecognised Jev answer keeps the current model;
- low confidence never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `JEV_ALLOW_FABLE=1`.

Tool-loop continuations keep the model chosen at the start of the turn. Main conversations and
sub-agents are pinned separately. Routing is fail-open: Jev failure never blocks Claude Code.

## Configuration

| Variable | Effect |
| --- | --- |
| `JEV_API_KEY` | Enables routing. `TYPESAFE_API_KEY` also works. |
| `JEV_ALLOW_FABLE` | Enables the opt-in long tier. |
| `JEV_DEBUG` | Logs decisions and rewrites to `~/.claude-jev.log` in interactive sessions. |
| `JEV_DUMP` | Dumps request bodies for debugging wire-format changes. |
| `JEV_NO_STATUSLINE` | Disables the injected status line. |
| `ENABLE_TOOL_SEARCH` | `cj` sets `true`; set `false` to load every MCP tool upfront. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `cj` sets `1000000`, the routed models' window. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, then `~/.claude-jev.env`.

Tier definitions, model facts, Jev's questions, confidence thresholds, and timeouts live in
`src/config.mjs`. Jev chooses among the exact models in the signed-in account's catalog, so
model versions such as `claude-opus-5` and `claude-opus-5-5` remain separate choices. Static
model ids are used only until Claude Code fetches its catalog. When a new model generation
ships, update `TIERS` and `MODEL_FACTS` in `src/config.mjs`.

## Compatibility notes

- Claude Code needs schema normalisation for older MCP JSON Schema fields when a custom base
  URL is active.
- Request fields a routed model cannot accept, such as adaptive thinking and `effort` on
  Claude 4.5 and older, are removed before forwarding.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env

npm test
node test/live-routing.mjs
node bin/cj.mjs -p "what is 2+2?"
```

The test suite covers policy, the request format, model rewriting, capability handling,
conversation context, settings restoration, native model-picker injection, and decision
display.

## Limitations

- The new prompt is sent to TypeSafe for the routing decision, and so is a bounded slice of
  the conversation, so a terse follow-up is judged by the work it continues: up to six
  earlier prompts and the compaction summary (clipped), the assistant's last reply
  (clipped), recent tool-call counts, and the paths of files edited. File contents and tool
  output are not sent directly, though the assistant's reply may quote them.
- Jev adds latency only to the first request of a turn; tool-loop continuations add none.
- Claude Code's request format is not a public contract. Use `JEV_DUMP` to diagnose upstream
  changes.

## License

MIT
