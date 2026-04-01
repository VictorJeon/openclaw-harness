# OpenClaw Harness

OpenClaw Harness is the **harness-first coding plugin** for OpenClaw.

The primary surface is **`harness_execute`**:
- classify the request
- choose tier 0 / 1 / 2
- dispatch the worker
- run review / fix / re-review loops
- return a structured result

The old direct Claude session tools still exist, but they are the **legacy surface**.

---

## Current verified state (2026-04-01)

Verified in live smoke runs:
- caller-agent direct **plan review** for tier 2
- **Codex ACP** final review
- tier 2 realtime **resume-safe** recovery
- tier 2 same-session follow-up review/fix/re-review
- tier 1 worker continuity + **persistent Codex reviewer session**
- single-feature workflow collapse (fewer unnecessary task splits)

Recent implementation commits:
- `e3ba164` — embedded plan review + tier 2 sync
- `f8c2e76` — single-feature workflow collapse
- `4827ef5` — tier 2 realtime review-loop continuation
- `4d79f72` — persistent Codex reviewer sessions

---

## Execution model

| Tier | When used | Worker | Reviewer |
|------|-----------|--------|----------|
| **0** | tiny/local-safe edits | caller agent direct | none |
| **1** | normal coding tasks | harness worker session | Codex ACP |
| **2** | complex / high-risk / multi-step coding | `claude-realtime.sh` on Hetzner | caller-agent plan review + Codex ACP |

### Tier 1
- worker runs through the harness worker path
- review loop can request fixes
- Codex ACP reviewer session is persisted per plan/task

### Tier 2
- worker runs through `claude-realtime.sh` on Hetzner
- plan review is produced by the **calling agent directly** (embedded runtime path)
- repo is synced back before Codex ACP review
- realtime follow-up fixes continue in the same worker session

---

## Primary tool

### `harness_execute`

Use this for new coding tasks.

Example:

```txt
harness_execute(
  request: "Fix the auth refresh bug in src/auth.ts",
  workdir: "/path/to/repo"
)
```

Useful parameters:
- `request`
- `workdir`
- `mode` = `ask` | `delegate` | `autonomous`
- `tier_override` = `0` | `1` | `2`
- `max_budget_usd`
- `approved_plan_id`

Typical flow:
1. router classifies complexity
2. planner builds task list
3. worker executes
4. reviewer checks gaps
5. fix loop runs if needed
6. structured result returned

---

## Legacy surface

Legacy tools remain for interactive raw session control:
- `harness_launch`
- `harness_respond`
- `harness_fg`
- `harness_bg`
- `harness_kill`
- `harness_output`
- `harness_sessions`
- `harness_stats`

These are still useful for:
- interactive PTY sessions
- debugging old session flows
- resuming older direct Claude sessions

For new automated coding tasks, prefer **`harness_execute`**.

---

## Local development

```bash
cd /Users/nova/.openclaw/extensions/openclaw-harness
npm run build
openclaw gateway restart
```

> Plugin code changes require a gateway restart to reload the built extension.

---

## Documentation

- `docs/ARCHITECTURE.md` — current harness architecture
- `docs/DEVELOPMENT.md` — code layout + development notes
- `docs/tools.md` — tool surface reference
- `docs/safety.md` — legacy direct-session safety checks only
- `docs/NOTIFICATIONS.md` — notification behavior

---

## Source of truth

When docs and code disagree, the source of truth is:
1. `src/tools/harness-execute.ts`
2. `src/router.ts`
3. `src/planner.ts`
4. `src/review-loop.ts`
5. live smoke results / checkpoint files
