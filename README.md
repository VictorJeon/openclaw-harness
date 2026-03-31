# OpenClaw plugin to orchestrate Claude Code

Orchestrate Claude Code sessions as managed background processes from any OpenClaw channel.

Launch, monitor, and interact with multiple Claude Code SDK sessions directly from Telegram, Discord, or any OpenClaw-supported platform — without leaving your chat interface.

[![Demo Video](https://img.youtube.com/vi/vbX1Y0Nx4Tc/maxresdefault.jpg)](https://youtube.com/shorts/vbX1Y0Nx4Tc)

*Two parallel Claude Code agents building an X clone and an Instagram clone simultaneously from Telegram.*

---

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install @betrue/openclaw-claude-code-plugin
openclaw gateway restart
```

### 2. Configure notifications (minimal)

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-claude-code-plugin": {
        "enabled": true,
        "config": {
          "fallbackChannel": "telegram|my-bot|123456789",
          "maxSessions": 5
        }
      }
    }
  }
}
```

### 3. Run your first coding task

Ask your agent: *"Fix the bug in auth.ts"*

The agent calls **`harness_execute`** — the primary path:

```
harness_execute("Fix the bug in auth.ts")
```

The harness classifies complexity, decomposes the work, dispatches worker sessions, and returns structured results with any gaps flagged. No manual session management needed.

> **Legacy path:** If you need interactive/multi-turn PTY sessions, the `/harness*` commands and `harness_launch` are still fully supported but are the legacy surface. See [docs/safety.md](docs/safety.md) for the one-time setup those require.

---

## Features

- **Multi-session management** — Run multiple concurrent sessions, each with a unique ID and human-readable name
- **Foreground / background model** — Sessions run in background by default; bring any to foreground to stream output in real time, with catchup of missed output
- **Real-time notifications** — Get notified on completion, failure, or when Claude asks a question
- **Multi-turn conversations** — Send follow-up messages, interrupt, or iterate with a running agent
- **Session resume & fork** — Resume any completed session or fork it into a new conversation branch
- **4 pre-launch safety checks** — Autonomy skill, heartbeat config, HEARTBEAT.md, and channel mapping
- **Multi-agent support** — Route notifications to the correct agent/chat via workspace-based channel mapping
- **Automatic cleanup** — Completed sessions garbage-collected after 1 hour; IDs persist for resume

---

## Tools

### Primary path — Harness (Plan-Work-Review)

| Tool | Description |
|------|-------------|
| `harness_execute` | **Primary.** Execute a coding task with automatic planning, worker dispatch, and cross-model review. Returns structured results with gaps detected. |

### Legacy path — Direct Claude Session surface

The tools below provide direct PTY access to Claude Code sessions. They predate `harness_execute` and are still supported for interactive/multi-turn use cases that need raw session control. For automated coding tasks, prefer `harness_execute`.

| Tool | Description |
|------|-------------|
| `harness_launch` | [LEGACY] Start a new Claude Code session in background |
| `harness_respond` | [LEGACY] Send a follow-up message to a running session |
| `harness_fg` | [LEGACY] Bring a session to foreground — stream output in real time |
| `harness_bg` | [LEGACY] Send a session back to background — stop streaming |
| `harness_kill` | [LEGACY] Terminate a running session |
| `harness_output` | [LEGACY] Read buffered output from a session |
| `harness_sessions` | [LEGACY] List all sessions with status and progress |
| `harness_stats` | Show usage metrics (counts, durations, costs) — covers all paths |

All legacy tools are also available as **chat commands** (`/harness`, `/harness_fg`, etc.) and most as **gateway RPC methods**.

> Full parameter tables and response schemas: [docs/API.md](docs/API.md)

---

## Quick Usage

### Primary path — `harness_execute` (recommended for coding tasks)

Ask your agent a coding task directly:

> *"Add input validation to the signup endpoint"*

The agent calls `harness_execute`:

```
harness_execute("Add input validation to the signup endpoint")
```

The harness classifies complexity, decomposes the work, dispatches worker sessions, and runs a cross-model review. Results are returned as structured output with any gaps flagged for a follow-up fix loop — no manual session management needed.

Use `/harness_stats` (or `harness_stats`) at any time to see metrics across all sessions.

### Legacy path — direct session commands (interactive / multi-turn)

For raw PTY access or interactive sessions that need turn-by-turn control, the `/harness*` commands are still supported:

```bash
# Launch a session
/harness Fix the authentication bug in src/auth.ts
/harness --name fix-auth Fix the authentication bug

# Monitor
/harness_sessions
/harness_fg fix-auth
/harness_bg fix-auth

# Interact
/harness_respond fix-auth Also add unit tests
/harness_respond --interrupt fix-auth Stop that and do this instead

# Lifecycle
/harness_kill fix-auth
/harness_resume fix-auth Add error handling
/harness_resume --fork fix-auth Try a different approach
/harness_stats
```

---

## Notifications

The plugin sends real-time notifications to your chat based on session lifecycle events:

| Emoji | Event | Description |
|-------|-------|-------------|
| ↩️ | Launched | Session started successfully |
| 🔔 | Claude asks | Session is waiting for user input — includes output preview |
| ↩️ | Responded | Follow-up message delivered to session |
| ✅ | Completed | Session finished successfully |
| ❌ | Failed | Session encountered an error |
| ⛔ | Killed | Session was manually terminated |

Foreground sessions stream full output in real time. Background sessions only send lifecycle notifications.

> Notification architecture and delivery model: [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)

---

## Configuration

Set values in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-claude-code-plugin"].config`.

### Essential parameters

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentChannels` | `object` | — | Map workdir paths → notification channels |
| `fallbackChannel` | `string` | — | Default channel when no workspace match found |
| `maxSessions` | `number` | `5` | Maximum concurrent sessions |
| `maxAutoResponds` | `number` | `10` | Max consecutive auto-responds before requiring user input |
| `defaultBudgetUsd` | `number` | `5` | Default budget per session (USD) |
| `permissionMode` | `string` | `"bypassPermissions"` | `"default"` / `"plan"` / `"acceptEdits"` / `"bypassPermissions"` |
| `skipSafetyChecks` | `boolean` | `false` | Skip ALL pre-launch safety guards (autonomy skill, heartbeat, HEARTBEAT.md, agentChannels). For dev/testing only. |

### Example

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-claude-code-plugin": {
        "enabled": true,
        "config": {
          "maxSessions": 3,
          "defaultBudgetUsd": 10,
          "defaultModel": "sonnet",
          "permissionMode": "bypassPermissions",
          "fallbackChannel": "telegram|main-bot|123456789",
          "agentChannels": {
            "/home/user/agent-seo": "telegram|seo-bot|123456789",
            "/home/user/agent-main": "telegram|main-bot|123456789"
          }
        }
      }
    }
  }
}
```

---

## Skill Example

<details>
<summary>Example orchestration skill (click to expand)</summary>

The plugin is a **transparent transport layer** — business logic lives in **OpenClaw skills**:

```markdown
---
name: Coding Agent Orchestrator
description: Orchestrates Claude Code sessions with auto-response rules.
metadata: {"openclaw": {"requires": {"plugins": ["openclaw-claude-code-plugin"]}}}
---

# Coding Agent Orchestrator

## Auto-response rules

When a Claude Code session asks a question, analyze and decide:

### Auto-respond (use `harness_respond` immediately):
- Permission requests for file reads, writes, or bash commands -> "Yes, proceed."
- Confirmation prompts like "Should I continue?" -> "Yes, continue."

### Forward to user:
- Architecture decisions (Redis vs PostgreSQL, REST vs GraphQL...)
- Destructive operations (deleting files, dropping tables...)
- Anything involving credentials, secrets, or production environments

## Workflow

### Primary path (recommended)
1. User sends a coding task -> `harness_execute(prompt, ...)`
2. Harness classifies, decomposes, dispatches workers, and runs review loop.
3. On completion -> structured result with gaps; fix loop runs automatically if needed.
4. Report final result to user.

### Legacy path (interactive / multi-turn) [LEGACY]
1. User sends a coding task -> `harness_launch(prompt, ...)` [LEGACY]
2. Session runs in background. Monitor via wake events.
3. On wake event -> `harness_output` to read the question, then auto-respond or forward.
4. On completion -> summarize the result and notify the user.
```

A comprehensive orchestration skill is available at [`skills/claude-code-orchestration/SKILL.md`](skills/claude-code-orchestration/SKILL.md).

</details>

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/getting-started.md](docs/getting-started.md) | Full setup guide and first-launch walkthrough |
| [docs/API.md](docs/API.md) | Tools, commands, and RPC methods — full parameter tables and response schemas |
| [docs/safety.md](docs/safety.md) | Pre-launch safety checks for the legacy `harness_launch` path |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | Notification architecture, delivery model, and wake mechanism |
| [docs/AGENT_CHANNELS.md](docs/AGENT_CHANNELS.md) | Multi-agent setup, notification routing, and workspace mapping |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture overview and component breakdown |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Development guide, project structure, and build instructions |

---

## License

MIT — see [package.json](package.json) for details.
