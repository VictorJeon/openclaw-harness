# Tools Reference

## Primary tool

### `harness_execute`

`harness_execute` is the **primary coding tool**.

It runs the harness pipeline:
1. deterministically classify request
2. deterministically plan tasks
3. dispatch worker
4. review output
5. run fix loop if needed
6. return structured result

### Parameters

| Parameter | Description |
|-----------|-------------|
| `request` | natural-language coding task |
| `workdir` | repo / working directory |
| `mode` | `ask` / `delegate` / `autonomous` |
| `tier_override` | force tier `0`, `1`, or `2` |
| `max_budget_usd` | budget cap |
| `approved_plan_id` | resume from an approval-gated plan |

### Tier behavior

| Tier | Meaning |
|------|---------|
| `0` | tiny/local-safe edits |
| `1` | normal coding tasks |
| `2` | complex/high-risk/multi-step coding |

### Result shape

The returned result is structured. In practice you care about:
- overall completion status
- passed / failed task counts
- review loop count
- any remaining gaps or escalation notes

---

## Legacy tools

These tools still exist, but they are the **legacy surface**:
- `harness_launch`
- `harness_respond`
- `harness_fg`
- `harness_bg`
- `harness_kill`
- `harness_output`
- `harness_sessions`
- `harness_stats`

Use them only when you truly need raw direct-session control.
For new automated coding work, prefer `harness_execute`.

---

## When to use what

| Need | Tool |
|------|------|
| automated coding task | `harness_execute` |
| approval-gated rerun of same plan | `harness_execute(..., approved_plan_id=...)` |
| raw PTY / direct Claude control | legacy tools |
| old-session debugging | legacy tools |

---

## Important behavior notes

- tier 1: `claude-realtime.sh` worker + Codex CLI review
- tier 2: same realtime worker path + embedded caller-agent plan review + Codex CLI review
- fix loops for coding tasks continue through the realtime worker path
- fix loops are automatic until pass or escalation
- legacy launch safety rules are documented separately in `docs/safety.md`
