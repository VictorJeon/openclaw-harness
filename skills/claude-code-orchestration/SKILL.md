---
name: Harness Orchestration
description: Skill for orchestrating the Plan-Work-Review harness. Covers task execution, cross-model review, gap detection, and lifecycle management.
metadata: {"openclaw": {"requires": {"plugins": ["openclaw-harness"]}}}
---

# Harness Orchestration

You orchestrate coding tasks via the `openclaw-harness` plugin. The harness automatically routes requests by complexity, decomposes tasks, dispatches workers, and runs cross-model review with gap detection.

---

## 1. Executing tasks

### Primary tool: `harness_execute`

The harness handles the full Plan-Work-Review loop automatically:

```
harness_execute(
  request: "V4 installer: add OpenRouter selection and update post-wizard validation",
  workdir: "/home/user/projects/myapp",
  mode: "delegate"
)
```

### What happens internally

1. **Router** classifies complexity: tier 0 (config/docs), tier 1 (simple coding), tier 2 (complex/multi-task)
2. **Planner** decomposes into tasks with acceptance criteria
3. **Dispatcher** spawns ACP Worker sessions
4. **Reviewer** (cross-model, ACP Codex) checks for 5 gap types
5. **Review loop** iterates fix-rereview up to 4 times
6. **Checkpoint** saves state for crash recovery

### Parameters

| Parameter | When to use |
|---|---|
| `request` | Always. Natural language task description. |
| `workdir` | Target project directory. |
| `mode` | `ask` (approve everything), `delegate` (default, auto safe ops), `autonomous` (fully auto) |
| `tier_override` | Force tier 0/1/2 when automatic classification is wrong. |
| `max_budget_usd` | Budget for all workers combined. |

### Tier classification

| Tier | Handles | Example |
|---|---|---|
| 0 | Config, docs, patches | "tsconfig strict mode on" |
| 1 | Single coding task | "Fix auth bug in login.ts" |
| 2 | Multi-task, architecture | "Rewrite auth system to use JWT" |

---

## 2. Gap taxonomy (5 types)

The reviewer checks for these gaps:

| Gap | Description | Example |
|---|---|---|
| `assumption_injection` | Added decisions not in the request | "Added JWT when not asked" |
| `scope_creep` | Features beyond what was requested | "Added notification to TODO app" |
| `direction_drift` | Implementation diverges from intent | "Full framework for simple API" |
| `missing_core` | Required functionality missing | "Search not implemented" |
| `over_engineering` | Excessive abstraction | "DI container for CRUD" |

---

## 3. Operation modes

| Mode | Plan approval | Execution | After review |
|---|---|---|---|
| **Ask** | Required | Required | User decides |
| **Delegate** | Auto (safe) | Auto (confirm risky) | Auto commit on pass |
| **Autonomous** | Auto | Auto | Auto commit, report failures |

Default: **Delegate**

---

## 4. Monitoring

### List sessions
```
harness_sessions()
harness_sessions(status: "running")
```

### View output
```
harness_output(session: "harness-plan-001-task-1", full: true)
```

### Live stream
```
harness_fg(session: "harness-plan-001-task-1")
harness_bg()
```

---

## 5. Session management

### Direct session launch (bypass harness)

For tasks that don't need the Plan-Work-Review loop:

```
harness_launch(
  prompt: "Quick fix: update version in package.json",
  name: "version-bump",
  workdir: "/home/user/projects/myapp",
  max_budget_usd: 1
)
```

### Respond to worker questions
```
harness_respond(session: "harness-plan-001-task-1", message: "Yes, use the existing auth middleware.")
```

### Kill a session
```
harness_kill(session: "harness-plan-001-task-1")
```

---

## 6. Cross-model review

The harness uses session ping-pong for quality:

- **Worker** (ACP Claude): implements + fixes
- **Reviewer** (ACP Codex): reviews + re-reviews

Same model building and reviewing shares blind spots. Different models catch different issues.

Review loop:
1. Worker implements
2. Reviewer finds gaps (or passes)
3. Worker fixes reported gaps
4. Reviewer re-reviews (up to 4 loops)
5. If still failing: escalation to user

---

## 7. Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Using `harness_launch` for complex tasks | Use `harness_execute` — it adds planning + review |
| Skipping review for "simple" changes | Let the router decide; tier 0 skips review automatically |
| Responding to all worker questions automatically | Forward architecture/destructive decisions to the user |
| Ignoring escalations | Review the gap evidence and fix manually or adjust the request |

---

## 8. Tool reference

| Tool | Purpose |
|---|---|
| `harness_execute` | Full Plan-Work-Review loop |
| `harness_launch` | Direct session launch (no review loop) |
| `harness_sessions` | List sessions |
| `harness_output` | View session output |
| `harness_fg` / `harness_bg` | Foreground/background |
| `harness_respond` | Send follow-up message |
| `harness_kill` | Terminate session |
| `harness_stats` | Usage metrics |
