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
- default backend remains `remote-realtime`; `workerBackend="local-cc"` is now available as an opt-in local lane

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
| **1** | normal coding tasks | default: `claude-realtime.sh` on Hetzner; opt-in: local Claude Code CLI via `workerBackend="local-cc"` | Codex CLI |
| **2** | complex / high-risk / multi-step coding | same backend split as Tier 1 | caller-agent plan review + Codex CLI |
| **review-only** | `reviewOnly=true` | none (synthesized from git diff) | Codex CLI |

### Tier 1
- default worker runs through `claude-realtime.sh`
- realtime worker requires project context: target repo must contain `CLAUDE.md` or `.claude/CLAUDE.md`; missing context now fails fast before launch
- `workerBackend="local-cc"` runs one-shot local Claude Code CLI rounds in the local workdir and persists state under `/tmp/openclaw-harness-local-cc/<jobId>`
- review loop can request fixes
- remote-realtime follow-up fixes continue in the **same Claude session** via realtime `jobId` + `session_id`
- local-cc follow-up fixes rerun a fresh local Claude CLI round with persisted `jobId` state reuse

### Review-only mode

Pass `reviewOnly: true` to skip planner/worker and review existing local changes:

```txt
harness_execute(
  request: "Review my auth refactor for gaps",
  workdir: "/path/to/repo",
  reviewOnly: true
)
```

- Collects changed files from `git diff` (staged + unstaged + untracked)
- Synthesizes a `WorkerResult` from local changes
- Runs the existing Codex CLI reviewer path
- Returns structured review result with gaps (if any)
- Does **not** enter the worker fix loop — reviewer is read-only
- Fails clearly if there are no local changes to review

### Tier 2
- worker uses the configured tier-1 backend (`remote-realtime` by default, `local-cc` when opted in)
- the calling agent resolves `plan_waiting` checkpoints in-band
- implementation `waiting` checkpoints are reviewed by Codex via the durable realtime owner, so Claude Code ↔ Codex ping-pong remains intact even if the original harness turn dies
- remote-realtime syncs the repo back before Codex CLI review
- local-cc works directly in the local workdir, so no remote sync step is involved

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
- `reviewOnly` — skip planner/worker, review local changes only

Realtime worker note:
- `harness_execute` with the default realtime worker requires project context in the target repo (`CLAUDE.md` or `.claude/CLAUDE.md`). Missing context fails before launch instead of getting stuck in `launching`.
- `tier_override` = `0` | `1` | `2`
- `max_budget_usd`
- `approved_plan_id`

Typical flow:
1. deterministic router classifies complexity
2. model-backed planner builds the task list (Opus primary, Sonnet fallback)
3. selected worker backend executes for tier 1+ (`remote-realtime` by default, optional `local-cc` locally)
4. for realtime lanes, the calling agent resolves `plan_waiting`, while implementation `waiting` is handed to the durable realtime owner for Codex review so worker rounds do not hang waiting for an external DONE signal
5. Codex CLI reviewer checks final gaps
6. fix loop runs if needed
7. structured result returned

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
git clone https://github.com/VictorJeon/openclaw-harness.git ~/.openclaw/extensions/openclaw-harness
cd ~/.openclaw/extensions/openclaw-harness
git checkout v0.2.6
npm install
npm run build
```

For stable rollouts, pin to a known-good release instead of tracking `main` blindly.
Current Nana/local-cc-ready release: **`v0.2.6`**.

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
          workerBackend: "remote-realtime",
          enableLegacyTools: false
        }
      }
    }
  }
}
```

After config changes, restart the gateway.

### Nana local-only (`workerBackend="local-cc"`)

For Nana/local installs, keep the planner/reviewer local and opt into the local Claude Code worker lane:

```json5
{
  plugins: {
    entries: {
      "openclaw-harness": {
        enabled: true,
        config: {
          operationMode: "delegate",
          plannerModel: "anthropic/claude-opus-4-6",
          reviewModel: "openai-codex/gpt-5.4",
          realtimeModel: "anthropic/claude-opus-4-6",
          workerBackend: "local-cc",
          workerEffort: "high",
          reviewerReasoningEffort: "xhigh",
          enableLegacyTools: false
        }
      }
    }
  }
}
```

Requirements for `local-cc`:
- `claude` must be available in the gateway runtime PATH
- `codex` should also be available for the reviewer path
- the plugin must be present under `~/.openclaw/extensions/openclaw-harness`
- `plugins.allow` must include `openclaw-harness`
- if you install outside the default extensions directory, add the parent directory to `plugins.load.paths`

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
