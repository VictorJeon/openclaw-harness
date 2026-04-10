# OpenClaw Harness

Harness-first coding plugin for OpenClaw. Automates **Plan → Work → Review** loops with cross-model consensus review, async fire-and-forget execution, and meta-reviewer mediation.

---

## What's new (2026-04-10)

- **Async fire-and-forget**: `harness_execute` returns plan_id in <3s, runs background, pushes result via Telegram
- **Reviewer consensus**: Codex (gpt-5.4) + GLM 5.1 parallel review with majority vote
- **Meta-reviewer**: mediation before human escalation (approve / revise / reject)
- **LLM Router**: 3-layer cascade (pattern → keyword → LLM) for tier classification
- **Heartbeat**: 20s/30s progress push during worker execution
- **Analysis mode**: auto-detect read-only requests, skip worker
- **Session continuity**: worker `--resume`, reviewer `codex exec resume`
- **Per-gap severity**: over_engineering soft-filtered
- **effectiveTier**: min(router, planner) prevents over-classification
- **Stale cleanup**: auto-remove old plans (30 min running / 1 hour terminal)

---

## Execution model

```
Request → Router (pattern → keyword → LLM)
       → Planner (Opus, heuristic fallback)
       → effectiveTier = min(router, planner)
       → [ASYNC] Worker (Hetzner Claude) + Heartbeat (30s Telegram)
       → Reviewer Consensus (Codex + GLM parallel)
       → Fix Loop (max 10, session continuity)
       → Meta-reviewer (if exhausted)
       → Result Push (Telegram)
```

| Tier | Worker | Review | Mode |
|------|--------|--------|------|
| **0** | caller agent | none | sync |
| **1** | realtime/local-cc | consensus (Codex + GLM) | async |
| **2** | same + plan review | plan review + consensus | async |
| **analysis** | none | none | sync read-only |
| **review-only** | none (git diff) | Codex CLI | sync |

---

## Cross-model matrix

| Role | Model | Provider |
|------|-------|----------|
| Worker | Claude Opus 4.6 | Anthropic (Hetzner) |
| Primary reviewer | gpt-5.4 | Codex CLI |
| Secondary reviewer | GLM 5.1 | OpenRouter |
| Meta-reviewer | gpt-5.4 | Codex CLI |
| Planner | Claude Opus 4.6 | Anthropic |

---

## Quick start

```bash
git clone https://github.com/VictorJeon/openclaw-harness.git ~/projects/openclaw-harness
cd ~/projects/openclaw-harness
npm install && npm run build
```

Config in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "openclaw-harness": {
        enabled: true,
        config: {
          plannerModel: "anthropic/claude-opus-4-6",
          reviewModel: "openai-codex/gpt-5.4",
          realtimeModel: "anthropic/claude-opus-4-6",
          consensusReviewerModel: "z-ai/glm-5.1",
          openRouterApiKey: "<your-openrouter-key>",
          workerBackend: "remote-realtime",
          maxReviewLoops: 10,
          reviewerReasoningEffort: "xhigh",
          workerEffort: "high",
          enableLegacyTools: false
        }
      }
    }
  }
}
```

Restart gateway after config changes: `openclaw gateway restart`

---

## Documentation

| Doc | Content |
|-----|---------|
| `docs/ARCHITECTURE.md` | Full architecture + flow diagrams |
| `docs/DEVELOPMENT.md` | Code layout + where to change what |
| `docs/tools.md` | Tool parameter reference |
| `docs/NOTIFICATIONS.md` | Heartbeat + notification behavior |
| `docs/safety.md` | Legacy launch guards only |

---

## Source of truth

When docs and code disagree: `src/tools/harness-execute.ts` > `src/router.ts` > `src/reviewer-consensus.ts` > docs.
