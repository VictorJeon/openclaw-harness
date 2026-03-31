# Tools Reference

All tools provided by the OpenClaw Claude Code plugin. Each tool is exposed to agents via the OpenClaw tool system.

> **Source of truth:** `src/tools/`

---

## Execution Paths — Primary vs Legacy

The plugin exposes two execution paths:

| Path | Entry point | When to use |
|------|-------------|-------------|
| **Primary — Harness** | `harness_execute` | **Recommended for all automated coding tasks.** Auto-classifies complexity, decomposes into tasks, dispatches workers, runs cross-model review, returns structured results with gaps detected. |
| **Legacy — Direct sessions** | `harness_launch` + `harness_respond` + `harness_fg` / `harness_bg` / `harness_kill` / `harness_output` / `harness_sessions` / `harness_stats` | Interactive/multi-turn sessions requiring direct PTY access; debugging; sessions that predate the harness. **Prefer `harness_execute` for new work.** |

---

## Tool Summary

### Primary

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `harness_execute` | **Primary coding path.** Execute a coding task through the Plan-Work-Review harness | `request`, `workdir`, `mode`, `tier_override`, `max_budget_usd`, `approved_plan_id` |

### Legacy (Direct-Session) [LEGACY]

> These tools remain fully supported but are the **legacy direct-session surface**. Use `harness_execute` for new automated coding tasks.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `harness_launch` | Launch a Claude Code session directly | `prompt`, `workdir`, `name`, `model`, `resume_session_id` |
| `harness_respond` | Send follow-up message to a running session | `session`, `message`, `interrupt`, `userInitiated` |
| `harness_fg` | Bring a session to foreground for streaming | `session`, `lines` |
| `harness_bg` | Send a session to background | `session` (optional) |
| `harness_kill` | Terminate a session | `session` |
| `harness_output` | Show session output (read-only) | `session`, `lines`, `full` |
| `harness_sessions` | List all sessions | `status` |
| `harness_stats` | Show usage metrics | *(none)* |

> **Note:** There is no separate resume tool. To resume a previous session, use `harness_launch` with the `resume_session_id` parameter.

---

## harness_execute

Execute a coding task through the Plan-Work-Review harness. **This is the primary coding path** for automated development tasks.

Automatically classifies complexity, decomposes the task, dispatches workers, and runs cross-model review. Returns a structured result with any gaps detected.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `request` | string | **yes** | — | The coding task to execute (natural language) |
| `workdir` | string | no | agent workspace / cwd | Working directory for the task |
| `mode` | enum | no | `delegate` | Operation mode: `ask` (all approvals), `delegate` (auto safe ops), `autonomous` (fully auto) |
| `tier_override` | number | no | auto-classified | Override automatic tier classification: `0`, `1`, or `2` |
| `max_budget_usd` | number | no | plugin config | Maximum budget in USD |
| `approved_plan_id` | string | no | — | Plan ID from a previous approval-gated response — pass this to skip the approval gate and execute the approved plan |

### Example

```
harness_execute(
  request: "Fix the authentication bug in src/auth.ts — users are logged out after refresh",
  workdir: "/home/user/my-project"
)
```

### With Mode Override

```
harness_execute(
  request: "Refactor the payment module to use the new Stripe SDK",
  workdir: "/home/user/my-project",
  mode: "autonomous"
)
```

---

## Legacy Direct-Session Tools [LEGACY]

> The following tools are the **legacy direct-session surface**. They remain fully supported for interactive/multi-turn sessions, debugging, and resuming sessions that predate the harness. For new automated coding tasks, prefer `harness_execute`.

---

## harness_launch [LEGACY]

Launch a Claude Code session in the background to execute a development task. Sessions are multi-turn by default (they stay open for follow-up messages via `harness_respond`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **yes** | — | The task prompt to execute |
| `name` | string | no | auto-generated | Short kebab-case name (e.g. `fix-auth`). Auto-generated from prompt if omitted |
| `workdir` | string | no | agent workspace / cwd | Working directory for the session |
| `model` | string | no | plugin default | Model name to use |
| `max_budget_usd` | number | no | `5` | Maximum budget in USD |
| `system_prompt` | string | no | — | Additional system prompt injected into the session |
| `allowed_tools` | string[] | no | — | List of allowed tools for the Claude session |
| `resume_session_id` | string | no | — | Claude session ID to resume (from a previous session's `claudeSessionId`). Accepts name, internal ID, or Claude UUID — the plugin resolves it |
| `fork_session` | boolean | no | `false` | When resuming, fork to a new session instead of continuing the existing one. Use with `resume_session_id` |
| `multi_turn_disabled` | boolean | no | `false` | Disable multi-turn mode. Set to `true` for fire-and-forget sessions that don't accept follow-ups |
| `permission_mode` | enum | no | plugin config / `bypassPermissions` | One of: `default`, `plan`, `acceptEdits`, `bypassPermissions` |

### Pre-Launch Guards

Before spawning, `harness_launch` runs [4 mandatory safety checks](safety.md). If any check fails, the launch is blocked with an actionable error message. Other tools and the gateway RPC skip these guards.

### Example

```
harness_launch(
  prompt: "Fix the authentication bug in src/auth.ts — users are logged out after refresh",
  name: "fix-auth-bug",
  workdir: "/home/user/my-project",
  max_budget_usd: 3
)
```

### Resuming a Previous Session

```
harness_launch(
  prompt: "Continue where you left off — also add tests for the fix",
  resume_session_id: "abc12345",
  name: "fix-auth-continued"
)
```

### Forking a Session

```
harness_launch(
  prompt: "Try an alternative approach using JWT instead",
  resume_session_id: "abc12345",
  fork_session: true,
  name: "fix-auth-jwt-approach"
)
```

---

## harness_respond [LEGACY]

Send a follow-up message to a running multi-turn Claude Code session.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID |
| `message` | string | **yes** | — | The message to send |
| `interrupt` | boolean | no | `false` | Interrupt the current turn before sending. Useful to redirect the session mid-response |
| `userInitiated` | boolean | no | `false` | Set to `true` when the message comes from the user (not auto-generated). Resets the auto-respond counter |

### Auto-Respond Safety Cap

The plugin tracks how many times an agent auto-responds to a session. When the counter reaches `maxAutoResponds` (default: 10), further agent-initiated responds are blocked. This prevents infinite agent-session loops.

- **Agent responds** increment the counter
- **User-initiated responds** (`userInitiated: true`) reset the counter to 0
- When blocked, the agent is instructed to ask the user for input

### Example

```
harness_respond(
  session: "fix-auth-bug",
  message: "Yes, use the refresh token stored in httpOnly cookies"
)
```

### Interrupting and Redirecting

```
harness_respond(
  session: "fix-auth-bug",
  message: "Stop — don't modify the database schema. Only change the token logic.",
  interrupt: true
)
```

---

## harness_fg [LEGACY]

Bring a Claude Code session to the foreground. Shows buffered output and starts streaming new output to the current channel.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID |
| `lines` | number | no | `30` | Number of recent buffered lines to show |

### Catchup Output

When a session is brought to foreground, the plugin checks for "catchup" output — lines produced while the channel was backgrounded. If catchup output exists, it's shown instead of the generic last-N lines.

### Example

```
harness_fg(session: "fix-auth-bug", lines: 50)
```

**Output:**
```
Session fix-auth-bug [a1b2c3d4] now in foreground.
Status: RUNNING | Duration: 2m 15s
────────────────────────────────────────────────────────────
📋 Catchup (3 missed outputs):
...
────────────────────────────────────────────────────────────
Streaming new output... Use harness_bg to detach.
```

---

## harness_bg [LEGACY]

Send a Claude Code session back to background (stop streaming output). Saves the current output offset so `harness_fg` can show catchup later.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | no | — | Session name or ID. If omitted, detaches whichever session(s) are currently in foreground for this channel |

### Example

```
# Background a specific session
harness_bg(session: "fix-auth-bug")

# Background whatever is currently in foreground
harness_bg()
```

---

## harness_kill [LEGACY]

Terminate a running Claude Code session. Cannot kill sessions that are already in a terminal state (`completed`, `failed`, `killed`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID to terminate |

### Example

```
harness_kill(session: "fix-auth-bug")
```

---

## harness_output [LEGACY]

Show recent output from a Claude Code session. Read-only — does not change foreground state or affect streaming.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID |
| `lines` | number | no | `50` | Number of recent lines to show |
| `full` | boolean | no | `false` | Show all available output (up to the 200-line buffer) |

### Example

```
harness_output(session: "fix-auth-bug", lines: 100)
```

**Output:**
```
Session: fix-auth-bug [a1b2c3d4] | Status: RUNNING | Duration: 5m 30s
────────────────────────────────────────────────────────────
[session output lines...]
```

---

## harness_sessions [LEGACY]

List all Claude Code sessions with their status and progress. When called by an agent with a workspace context, sessions are filtered to show only that agent's sessions (matched via `originChannel`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | enum | no | `all` | Filter by status: `all`, `running`, `completed`, `failed` |

### Agent-Aware Filtering

When an agent calls `harness_sessions`, the plugin resolves the agent's channel from `agentChannels` config and filters sessions by `originChannel`. This ensures each agent only sees its own sessions. Falls back to showing all sessions if no channel mapping is found.

### Example

```
harness_sessions(status: "running")
```

**Output:**
```
🟢 fix-auth-bug [a1b2c3d4] — RUNNING (2m 15s) multi-turn
   Prompt: "Fix the authentication bug in src/auth.ts..."
   Claude Session ID: 550e8400-e29b-41d4-a716-446655440000

🏁 setup-heartbeat [e5f6g7h8] — COMPLETED (45s) single-turn
   Prompt: "Restart Gateway to activate heartbeat..."
   Claude Session ID: 6ba7b810-9dad-11d1-80b4-00c04fd430c8
```

---

## harness_stats [LEGACY]

Show Claude Code Plugin usage metrics: session counts by status, total cost, average duration, and the most expensive session.

### Parameters

*(none)*

### Example

```
harness_stats()
```

**Output:**
```
Total launched: 12
Completed: 8 | Failed: 2 | Killed: 2
Total cost: $4.23
Average duration: 3m 45s
Most expensive: fix-auth-bug ($1.20) — "Fix the authentication bug..."
```

---

## Session Lifecycle

```
harness_launch  ──►  STARTING  ──►  RUNNING  ──►  COMPLETED
                                     │              ▲
                                     │              │
                                     ▼              │
                               harness_respond ──────┘
                               harness_fg / harness_bg
                               harness_output
                                     │
                                     ▼
                               harness_kill  ──►  KILLED

                               (errors)    ──►  FAILED
```

- **STARTING** — Session is initializing (building SDK options, connecting)
- **RUNNING** — Session is active and accepting messages
- **COMPLETED** — Session finished successfully
- **FAILED** — Session errored out
- **KILLED** — Session was terminated via `harness_kill`

---

## Session Resolution

Most tools accept a `session` parameter that can be either a **session name** (e.g. `fix-auth-bug`) or a **session ID** (e.g. `a1b2c3d4`). The plugin resolves by ID first, then falls back to name matching.

For `harness_launch` with `resume_session_id`, the plugin additionally checks persisted sessions (sessions that have been garbage-collected from memory but whose metadata is still stored). It accepts internal IDs, session names, or Claude UUIDs.
