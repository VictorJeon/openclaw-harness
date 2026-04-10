# Architecture

> Last updated: 2026-04-10 (async fire-and-forget, consensus review, meta-reviewer, heartbeat)

## Overview

OpenClaw Harness has two surfaces:

| Surface | Status | Purpose |
|---------|--------|---------|
| `harness_execute` | **primary** | automated Plan → Work → Review execution |
| `/harness*` + legacy tools | legacy | direct PTY session control |

---

## Primary path: `harness_execute`

```
request
  → router (3-layer: pattern → keyword → LLM)
  → planner (Opus model-backed, heuristic fallback)
  → effectiveTier = min(router, planner)
  → analysis mode check (read-only requests skip worker)
  → [ASYNC] worker dispatch (returns plan_id immediately)
  → heartbeat (20s initial, 30s intervals via Telegram)
  → reviewer consensus (Codex + GLM parallel)
  → fix loop (max 10, same-session continuity)
  → meta-reviewer (if fix loop exhausted: approve/revise/reject)
  → result push (direct Telegram notification)
```

### Async fire-and-forget

`harness_execute` returns immediately (~1-3s) with the plan_id. The full pipeline runs in background. Results are pushed to Telegram on completion. This unblocks the orchestrator (Nova) so it can handle other messages during long runs.

### Core stages

1. **Router** (`src/router.ts`)
   - 3-layer cascade: regex pattern → keyword scoring → LLM classification
   - Layer 1 + 2 handle ~90% of requests at 0 tokens
   - Layer 3 (LLM) fires only for ambiguous requests (~500 tokens, 15s timeout)
   - Graceful degradation: if LLM unavailable, falls back to length heuristic

2. **Planner** (`src/planner.ts`)
   - Model-backed (Opus primary, Sonnet fallback, heuristic final fallback)
   - effectiveTier = min(router.tier, planner.tier) — prevents over-classification
   - Tier 1: single-task plan. Tier 2: multi-task decomposition (max 6 tasks)

3. **Worker execution** (`src/tools/harness-execute.ts`)
   - Tier 0: caller agent direct (sync). Tier 1+: backend-selected worker (async)
   - Analysis mode: read-only requests auto-detected, skip worker
   - Heartbeat: 20s initial, 30s intervals via direct Telegram push

4. **Reviewer consensus** (`src/reviewer-consensus.ts`)
   - Primary: Codex CLI (gpt-5.4). Secondary: GLM 5.1 via OpenRouter (parallel)
   - Both pass → pass. Both fail → merge gaps. Disagree → conservative fail
   - If one reviewer fails → use the other (graceful degradation)

5. **Review loop** (`src/review-loop.ts`)
   - Same-session continuity: `codex exec resume <id>`
   - Per-gap severity: over_engineering(0.3) soft-filtered below threshold 0.5
   - Max 10 fix-rereview cycles

6. **Meta-reviewer** (`src/meta-reviewer.ts`)
   - Fires when fix loop exhausted (before human escalation)
   - approve → force pass. revise → bonus fix round. reject → escalate

7. **Checkpointing** (`src/checkpoint.ts`)
   - Per-run on disk (`/tmp/harness/<plan-id>/`)
   - Stale cleanup: 30 min running / 1 hour terminal (auto GC every 5 min)

---

## Worker backends

| Backend | Default | Worker | Sync |
|---------|---------|--------|------|
| `remote-realtime` | **yes** | `claude-realtime.sh` on Hetzner | git-sync.sh |
| `local-cc` | opt-in | local `claude` CLI | direct filesystem |

---

## Tier model

| Tier | Worker | Review | Mode |
|------|--------|--------|------|
| **0** | caller agent | none | sync |
| **1** | realtime/local-cc | consensus (Codex + GLM) | async |
| **2** | same + plan review | embedded plan review + consensus | async |
| **review-only** | none (git diff) | Codex CLI | sync |
| **analysis** | none | none | sync read-only |

---

## Cross-model matrix

| Role | Model | Provider | Session |
|------|-------|----------|---------|
| Worker | Opus 4.6 | Anthropic (Hetzner) | `--resume` |
| Primary reviewer | gpt-5.4 | Codex CLI | `exec resume` |
| Secondary reviewer | GLM 5.1 | OpenRouter | stateless |
| Meta-reviewer | gpt-5.4 | Codex CLI | one-shot |
| Planner | Opus 4.6 | SessionManager | one-shot |
| LLM Router | plannerModel | SessionManager | one-shot |

---

## Gap taxonomy

| Type | Severity | Hard fail? |
|------|----------|-----------|
| `direction_drift` | 1.0 | yes |
| `missing_core` | 1.0 | yes |
| `assumption_injection` | 0.8 | yes |
| `scope_creep` | 0.7 | yes |
| `over_engineering` | 0.3 | **no** (soft) |

---

## Source files (priority)

1. `src/tools/harness-execute.ts`
2. `src/router.ts`
3. `src/reviewer-consensus.ts`
4. `src/meta-reviewer.ts`
5. `src/planner.ts`
6. `src/review-loop.ts`
7. `src/checkpoint.ts`

When docs and code disagree, code wins.
