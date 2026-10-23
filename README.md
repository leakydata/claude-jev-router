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

The injected status line shows the model used for the last turn and the session's cost so far
at API list prices, sub-agents included, measured from the responses the proxy forwarded:

```text
claude-haiku-5-5 (p=0.98) · my-project · 8% context · ≈$0.42
claude-opus-5-5 (p=0.91) · new task? /clear or /compact · my-project · 31% context · ≈$6.10
⏸ manual Opus 5.5 · my-project · 21% context · ≈$1.37
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
│ Selected model enough: 97%              │
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
size of the context decides most of the bill, and the model sets its price: Sonnet 5.5 reads
the cache for half what Opus 5.5 charges, and Haiku 5.5 for a twentieth. Measured over two weeks of real
sessions, cache reads were 61% of the cost, cache writes 30% and output 9%. `cj` acts on that:

- **MCP tool search stays on.** Claude Code turns tool search off behind a custom
  `ANTHROPIC_BASE_URL`; `cj` sets `ENABLE_TOOL_SEARCH=true`, so MCP tool definitions load on
  demand instead of riding along on every request. On one machine this cut the tool
  definitions in the first request from about 144K tokens to about 7K.
- **Compaction works, at 400K.** `cj` declares the routed models' 1M window
  (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) so Claude Code's proactive and idle compaction run, and
  seeds an auto-compact window of 400K the first time it starts. Replaying two weeks of
  sessions, Claude Code's own ~967K threshold saved 1%, 600K saved 30%, 400K saved 43%, and
  lower windows added many more compactions for little more.
- **The model is picked per turn** by Jev, using the conversation so far: the cheapest model
  that is probably enough, with a higher bar for Haiku (see Routing policy). On 164 real turns
  graded by Opus, only 18% needed Opus, so most work now runs on Sonnet 5.5.
- **Sub-agents are routed too.** A sub-agent that asks for a concrete model (Explore asks for
  Opus) is routed by Jev with that model as a ceiling: down, never up. Sub-agents were 44% of
  two weeks' spend. Picking a model yourself with `/model` pauses routing for that session's
  sub-agents as well.
- **Delegation hint.** A prompt hook asks Jev whether a request is bulky, self-contained
  gathering, such as searching a codebase, reading a long log, browsing pages or going through
  email. If so, it adds a note suggesting Claude hand it to a sub-agent, so only the conclusion
  enters the main conversation. Claude decides; set `CJ_NO_DELEGATION_HINT=1` to turn it off.
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

Not done, after measuring: clearing old tool results server-side (Anthropic's cost guide
finds it costs more in cache rewrites than it saves), changing effort per turn (that resets
the cache), and downscaling screenshots (images average about 930 tokens already; a 1280px
cap saves 9% of image tokens, and smaller caps cost legibility).

### Seeing the effect

`cj-report` prints where Claude Code's tokens went, from its own transcripts, so it covers
plain `claude` sessions too: totals, cache-hit rate, sub-agent share, compactions, and a
breakdown by component, model and day. `cj-report 30` covers 30 days. The first run reads every
transcript; later runs read only what was appended and take a fraction of a second.

### Checking quality

`cj-quality` measures whether routing costs quality, from real turns in Claude Code's
transcripts. Results stay under `~/.cache/claude-jev`, never in the repository.

- `cj-quality scan [days]` has Jev read the prompt that followed each turn for signs the turn
  fell short: a correction, "that's wrong", or the same request again. It reports the rate by
  the model that served the turn. It costs a fraction of a cent per turn.
- `cj-quality judge [count] [days]` has Opus 5.5 read sampled turns, including what the
  assistant actually did and the user's next message. For each turn it names the cheapest
  model that would have done it right in one pass, and says whether the turn as served went
  well. It runs `claude -p` on your own login with no tools, MCP servers or hooks, so it
  cannot act on the machine; a turn costs about 3 cents at list prices. Its labels become
  part of `npm run eval`.

Turns served by cheaper models are judged first, because that is where routing can cost
quality; the rest come from turns served by Opus, where routing may have spent more than it
needed to. `--subagents` grades sub-agent tasks instead, an equal share from each model.

- `cj-quality hints [days]` counts how often Claude used a sub-agent on turns where the
  delegation hint fired, against turns where it did not.
- `cj-weekly` writes the week's `cj-report`, scan and hint numbers to
  `~/.cache/claude-jev/weekly/` and shows a desktop notification. It warns when turns on
  Sonnet or Haiku fall short clearly more often than on Opus (5% before routing changed).
  `cj-weekly --install` runs it every Monday at 09:00 with a systemd user timer, catching up
  at the next start if the machine was off; rerun it after changing Node versions, and
  `--uninstall` removes it.

### Opus as an advisor (experimental)

With `CJ_ADVISOR=1` (in `~/.claude-jev.env` or the environment), turns routed to Sonnet get
the API's advisor tool: Sonnet does the work and can consult Opus 5.5 mid-response, at hard
points, for Opus's judgement at close to Sonnet's price. A short system note tells Sonnet
when to consult (concurrency, security, data loss, design choices, multi-file changes, a failed
attempt, and once before finishing long tasks); without it Sonnet almost never does.

- Sub-agents get it only when routed below the model they asked for.
- Claude Code drops the consultations from the history it replays, so the proxy keeps them
  per conversation and puts them back. That keeps the advice in view on later requests.
- Requests on other models have consultations stripped and no advisor tool, so their cached
  prefix is unchanged.
- Cost: each consultation reads the conversation at Opus's input price, uncached, because
  consultations are usually too far apart for a cache to be read back: about $0.60 at 150K
  tokens, plus 4-14K output tokens ($0.10-0.30). `cj-report` lists consultations as their own
  `(advisor)` row, the status line counts them, and `cj-quality scan` reports
  `+advisor` turns apart.

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
- Jev's answer is read as a probability that each tier is the cheapest one able to do the
  work, and routing takes the cheapest tier whose probability of being enough (its share plus
  every cheaper tier's) reaches 0.7, or 0.85 for Haiku;
- when Jev is at least 60% sure the prompt says the previous turn fell short (a correction,
  "still broken", the same request again), the turn runs one tier above the one that missed,
  and a miss on Opus stays on Opus;
- a move to a cheaper model mid-conversation must recover the cost of rebuilding its prompt
  cache within about 20 requests, priced from the conversation's real prompt size and what
  each model still holds cached: a new conversation, an expired cache, or a return to a model
  whose cache is still warm moves freely, and a long warm Opus conversation stays on Opus.
  This cache state is saved per conversation, so `cj --resume` after a restart keeps it;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `JEV_ALLOW_FABLE=1`.

Tool-loop continuations keep the model chosen at the start of the turn. Main conversations and
sub-agents are pinned separately. Routing is fail-open: Jev failure never blocks Claude Code.

## Configuration

| Variable | Effect |
| --- | --- |
| `JEV_API_KEY` | Enables routing. `TYPESAFE_API_KEY` also works. |
| `JEV_ALLOW_FABLE` | Enables the opt-in long tier. |
| `JEV_DEBUG` | Also logs every decision and rewrite to `~/.claude-jev.log` in interactive sessions. API errors (status, model, request id) are logged there always. |
| `JEV_DUMP` | Dumps request bodies for debugging wire-format changes. |
| `JEV_NO_STATUSLINE` | Disables the injected status line. |
| `CJ_NO_DELEGATION_HINT` | Turns off the prompt hook that suggests sub-agents. |
| `ENABLE_TOOL_SEARCH` | `cj` sets `true`; set `false` to load every MCP tool upfront. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `cj` sets `1000000`, the routed models' window. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, then `~/.claude-jev.env`.

Tier definitions, model facts, Jev's questions, routing thresholds, and timeouts live in
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
conversation context, sub-agent routing, usage accounting, the report, settings restoration,
native model-picker injection, and decision display.

### Routing quality

`npm run eval` scores live routing, after the policy, against labelled scenarios, and reports
misses as under-routed (a weaker model than needed: a quality risk) or over-routed (a cost).
It fails when a synthetic scenario is routed down to Haiku when it needed more. It then scores the same Jev answers under other policies, such as
other `enoughProbability` values, Jev's top choice, or always Sonnet, with a relative cost for
each, so a threshold change can be judged before it is made. `-- --rescore` re-scores the
last run's saved answers without calling Jev, and `-- --set synthetic|real` picks a set.

The repository's scenarios are synthetic. Real ones come from `cj-quality judge`, which writes
`~/.cache/claude-jev/eval/judged.jsonl`, and from your own labels: `npm run eval:harvest`
samples real prompts into `unlabelled.jsonl` beside it; fill in each `tier` and save the file
as `labelled.jsonl`. Your labels win over the judge's for the same prompt. Run the eval before
and after changing guidance or thresholds in `src/config.mjs`.

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
