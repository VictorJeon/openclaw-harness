# Tools Reference

> Last updated: 2026-04-10

## Primary tool: `harness_execute`

### Behavior

**Async fire-and-forget** for tier 1+:
- Returns plan_id in <3 seconds
- Full pipeline runs in background
- Results pushed to Telegram on completion
- Heartbeat every 30s during execution

**Sync** for tier 0, analysis mode, and review-only.

### Parameters

| Parameter | Description |
|-----------|-------------|
| `request` | Natural-language coding task |
| `workdir` | Repo / working directory |
| `tier_override` | Force tier `0`, `1`, or `2` |
| `max_budget_usd` | Budget cap (default: 5) |
| `reviewOnly` | Skip planner/worker, review local changes only |

### Tier behavior

| Tier | Meaning | Mode |
|------|---------|------|
| `0` | Config/doc/patch | sync, caller agent direct |
| `1` | Normal coding | async, worker + consensus review |
| `2` | Complex / multi-step | async, planner decomposition + worker + consensus review |

### Analysis mode

Requests containing analysis keywords ("분석", "검토", "조사", "analyze", "review", "inspect") without coding verbs → auto-detected as read-only. Returns immediately without spawning a worker.

### Review-only mode

```
harness_execute(request: "Review my changes", workdir: "/repo", reviewOnly: true)
```
Collects `git diff`, runs reviewer, returns gaps. No file modifications.

### Return shape (async)

```json
{
  "content": [{
    "type": "text",
    "text": "## Harness: Started (async)\n\n**Plan:** plan-YYYYMMDD-XXXXXX\n**Tasks:** N\n..."
  }]
}
```

Final result is pushed via Telegram (not returned in tool response).

---

## Legacy tools

Still available when `enableLegacyTools: true`:
- `harness_launch`, `harness_respond`, `harness_fg`, `harness_bg`
- `harness_kill`, `harness_output`, `harness_sessions`, `harness_stats`

For new coding work, use `harness_execute`.
