# `claude-jev` architecture

```mermaid
flowchart TB
  user([User]) --> command["`claude-jev`\nCLI wrapper"]

  subgraph launcher["Launcher — bin/claude-jev.mjs"]
    direction TB
    command --> env["Load environment\nprecedence: process env → .env → ~/.claude-jev.env → ~/.claude-jev.env"]
    env --> find["Find `claude` executable on PATH"]
    env --> saved["Read existing ~/.claude/settings.json model\nfor later restoration"]
    find --> key{"JEV_API_KEY or\nTYPESAFE_API_KEY?"}

    key -- No --> direct["Spawn real Claude Code\nwithout routing"]
    key -- Yes --> proxyStart["Start ephemeral loopback proxy\n127.0.0.1:random-port"]
    proxyStart --> launchEnv["Set ANTHROPIC_BASE_URL to proxy\nExpose `claude-jev` as Claude Jev in /model\nDefault to `claude-jev` unless user set ANTHROPIC_MODEL"]
    launchEnv --> statusCfg{"Status line allowed?"}
    statusCfg -- "No: JEV_NO_STATUSLINE or user statusLine" --> spawn
    statusCfg -- Yes --> statusCfgFile["Write temporary Claude status-line settings"] --> spawn
    direct --> spawn["Spawn real Claude Code\nwith original CLI arguments"]
  end

  spawn --> claude["Claude Code\n(native UI, login, tools, sessions, permissions)"]
  claude --> picker{"/model selection"}
  picker -- "Claude Jev" --> auto["model: `claude-jev`\n(routing sentinel)"]
  picker -- "Concrete model" --> manual["model: user-selected model"]
  auto --> loopback
  manual --> loopback

  subgraph proxy["Loopback proxy — src/proxy.mjs"]
    direction TB
    loopback["Receive HEAD or /v1/messages request"]
    loopback --> head{"HEAD probe?"}
    head -- Yes --> headOK["Return 200"]
    head -- No --> parse["Parse request body\nOptionally dump body with JEV_DUMP\nNormalize legacy MCP JSON schemas"]
    parse --> mode{"model is `claude-jev`?"}

    mode -- No --> pass["Leave model unchanged\nFor agent requests, publish manual status"]
    mode -- Yes --> conversation["Build conversation key\nsession ID + first-message text\nKeep up to 50 independent states"]
    conversation --> fresh{"Fresh user turn?\n(tool-bearing, last user text,\nnot a tool-result continuation)"}
    fresh -- No --> pinned["Reuse tier pinned for this conversation\n(default: sonnet)"]
    fresh -- Yes --> prompt["Remove system-reminder blocks\nEstimate context tokens"]
    prompt --> jev
    jev --> policy
    policy --> saveTier["Pin chosen tier in conversation state"]
    saveTier --> pinned
    pinned --> rewrite["Rewrite `claude-jev` to Claude tier model ID\nStrip unsupported thinking / effort fields"]
    rewrite --> publish["Write latest tier, confidence, and reason\nto per-session temp status file"]
    pass --> forward
    publish --> forward["Forward request to api.anthropic.com\nPreserve Claude Code authorization headers\nstream upstream response unchanged"]
  end

  subgraph routing["Routing — src/router.mjs + src/policy.mjs"]
    direction TB
    jev["TypeSafe / Jev systemOne call\nSends only fresh user prompt plus:\ncurrent tier, approximate context, available tiers"]
    policy["Policy resolves final tier\n• prompt override wins\n• failure / malformed answer: keep current\n• low confidence: no downgrade; upgrades capped at sonnet\n• large context: no downgrade that rebuilds cache\n• unavailable tier: choose nearest stronger available\n• fable requires JEV_ALLOW_FABLE=1"]
  end

  forward --> anthropic["Anthropic API"]
  anthropic --> claude

  subgraph visibility["Routing visibility — status.mjs + claude-jev-statusline.mjs"]
    direction TB
    statusFile["Temp file: $TMPDIR/claude-jev/<session>.json"]
    statusLine["Claude Code status-line command\nReads session file and renders:\n⚡ tier + confidence, or ⏸ manual"]
    statusFile --> statusLine
  end
  publish --> statusFile
  pass --> statusFile
  statusLine --> claude

  spawn --> exit["On process exit: close proxy\nand restore saved model only if it is still `claude-jev`"]
```

The routing call happens only for the first request of a user turn. Tool-loop continuations reuse
the pinned tier, avoiding repeated routing latency and model changes mid-task. A concrete model
chosen in Claude Code bypasses routing until the user selects **Claude Jev** again.
