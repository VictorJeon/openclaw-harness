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

## Current verified state (2026-04-04)

Verified in live smoke runs:
- caller-agent direct **plan review** for tier 2
- **Codex CLI** final review
- tier 1+ realtime worker routing confirmed
- realtime follow-up fixes continue in the **same Claude session** via `--resume`
- local sync-back materializes as **uncommitted worktree diff** (not merge commits)
- single-feature workflow collapse still works

Recent implementation commits:
- `a3bb1f0` — tier 1+ unify on realtime worker path
- `a7dae98` — pass worktree sync mode to realtime pull
- `d88ad59` — keep sync-back uncommitted in local worktree
- `34d7abb` — absorb Hetzner sync history safely

---

## Execution model

| Tier | When used | Worker | Reviewer |
|------|-----------|--------|----------|
| **0** | tiny/local-safe edits | caller agent direct | none |
| **1** | normal coding tasks | `claude-realtime.sh` on Hetzner | Codex CLI |
| **2** | complex / high-risk / multi-step coding | same realtime worker path | caller-agent plan review + Codex CLI |

### Tier 1
- worker runs through `claude-realtime.sh`
- review loop can request fixes
- follow-up fixes continue in the **same Claude session** via realtime `jobId` + `session_id`

### Tier 2
- worker runs through the same `claude-realtime.sh` path as Tier 1
- plan review is produced by the **calling agent directly** (embedded runtime path)
- repo is synced back before Codex CLI review
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
1. deterministic router classifies complexity
2. model-backed planner builds the task list (Opus primary, Sonnet fallback)
3. realtime worker executes for tier 1+
4. Codex CLI reviewer checks gaps
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

## Install from GitHub

```bash
git clone https://github.com/VictorJeon/openclaw-harness-private.git ~/.openclaw/extensions/openclaw-harness
cd ~/.openclaw/extensions/openclaw-harness
npm install
npm run build
```

For stable rollouts, pin to a known-good commit instead of tracking `main` blindly (current recommended pin: `8c82e24`).

Then enable it in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "openclaw-harness": {
        enabled: true,
        config: {
          operationMode: "autonomous",
          plannerModel: "anthropic/claude-opus-4-6",
          reviewModel: "openai-codex/gpt-5.4",
          realtimeModel: "anthropic/claude-opus-4-6",
          enableLegacyTools: false
        }
      }
    }
  }
}
```

After config changes, restart the gateway.

## Local development

```bash
cd /Users/nova/.openclaw/extensions/openclaw-harness
npm install
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
