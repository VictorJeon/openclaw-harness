# CLAUDE.md — OpenClaw Harness

## Purpose
Harness-first coding plugin for OpenClaw. Automates Plan → Work → Review loops with cross-model consensus review.

## Architecture (2026-04-10)
```
Request → Router (3-layer: pattern → keyword → LLM)
       → Planner (Opus model-backed, heuristic fallback)
       → effectiveTier = min(router, planner)
       → Worker dispatch (async fire-and-forget)
       → Reviewer consensus (Codex + GLM parallel)
       → Fix loop (max 10, same-session continuity)
       → Meta-reviewer mediation (before escalation)
       → Result push (direct Telegram)
```

## Key files
- `src/tools/harness-execute.ts` — main orchestration (async, heartbeat, notification)
- `src/router.ts` — 3-layer tier classification (pattern → keyword → LLM)
- `src/planner.ts` — model-backed task decomposition
- `src/reviewer-consensus.ts` — parallel Codex + GLM reviewer
- `src/meta-reviewer.ts` — escalation mediation
- `src/reviewer-runner.ts` — Codex CLI runner (session resume support)
- `src/reviewer-openrouter.ts` — OpenRouter API runner (GLM secondary)
- `src/review-loop.ts` — fix cycle orchestration
- `src/gap-types.ts` — 5-type gap taxonomy with severity weights
- `src/checkpoint.ts` — state persistence + stale cleanup

## Core constraints
- Async fire-and-forget: `harness_execute` returns plan_id in <3s, runs background, pushes result via Telegram
- Reviewer is read-only — never modifies code
- Cross-model review: worker(Claude) ≠ primary reviewer(Codex) ≠ secondary reviewer(GLM)
- Same-session continuity: worker `--resume`, reviewer `codex exec resume`
- effectiveTier = min(router, planner) — prevents planner over-classification
- Per-gap severity filtering: over_engineering(0.3) soft-filtered at threshold 0.5
- Analysis mode: read-only requests ("분석/검토") auto-detected, skip worker entirely

## Config (openclaw.json)
Key harness config fields:
- `plannerModel`: "anthropic/claude-opus-4-6"
- `reviewModel`: "openai-codex/gpt-5.4" (primary Codex reviewer)
- `consensusReviewerModel`: "z-ai/glm-5.1" (secondary via OpenRouter)
- `openRouterApiKey`: OpenRouter API key for secondary reviewer
- `realtimeModel`: "anthropic/claude-opus-4-6"
- `workerBackend`: "remote-realtime" | "local-cc"
- `maxReviewLoops`: 10
- `reviewerReasoningEffort`: "xhigh"

## When editing
- Read touched files before changing behavior
- Update tests for behavior changes
- Update docs when user-facing workflow changes
- Keep legacy direct-session tools secondary
- New config fields must be added to 3 places: `types.ts` + `shared.ts` + `openclaw.plugin.json`
