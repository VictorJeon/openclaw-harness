# 2026-04-04 — Realtime worker unification plan

## Goal

Remove the current Tier 1 Claude SDK worker path and make `claude-realtime.sh` the default worker runtime for all non-trivial coding work.

Keep:
- Tier 0 direct execution for tiny/local-safe edits
- Codex CLI reviewer path

Reduce / remove:
- Claude SDK session worker path for Tier 1
- architecture split between Tier 1 and Tier 2 worker runtimes
- ACP Claude assumptions in docs for the primary harness path

## Current live state

### Worker / reviewer split today
- Tier 0: caller agent direct
- Tier 1 worker: `sessionManager.spawn(...)` → `@anthropic-ai/claude-agent-sdk`
- Tier 1 review: Codex CLI when `reviewModel` is GPT/Codex
- Tier 2 worker: `claude-realtime.sh` on Hetzner
- Tier 2 review: embedded caller-agent plan review + Codex CLI review

### Problems
- Two separate Claude worker runtimes exist:
  1. Claude SDK session worker
  2. Claude Code CLI realtime worker
- This makes routing, failure recovery, budget behavior, and policy interpretation harder.
- The Anthropic policy concern applies more cleanly to the Claude SDK worker path than to direct Claude Code CLI usage.
- Docs and implementation have drifted; the current live path is hybrid.

## Target architecture

### Final runtime model
- **Tier 0**: unchanged, direct execution by caller agent
- **Tier 1**: realtime Claude worker (`claude-realtime.sh`) on Hetzner
- **Tier 2**: same realtime Claude worker path, reserved for complex planning / decomposition semantics
- **Reviewer**: Codex CLI

### Practical interpretation
This is effectively:
- keep Tier 0
- promote existing realtime worker path to the default worker path for all coding tasks above Tier 0
- remove the Claude SDK worker path from the main harness flow

## Required code changes

### 1) Worker dispatch in `src/tools/harness-execute.ts`
- Replace Tier 1 `sessionManager.spawn(...)` worker execution with the existing realtime worker execution path.
- Ensure fix loops continue against the same realtime worker/session state instead of spawning a fresh Claude SDK fix session.
- Keep reviewer execution on Codex CLI.
- Preserve checkpointing and structured final result contract.

### 2) Planner / routing semantics
- Update planner and routing assumptions so Tier 1 no longer implies Claude SDK worker.
- Keep Tier 0 unchanged.
- Decide whether Tier 1 vs Tier 2 still differ by planning strategy only, not by worker runtime.

### 3) Configuration behavior
- Primary harness path should no longer depend on `workerModel = anthropic/...` for Tier 1 SDK sessions.
- If config fields remain temporarily for compatibility, they should be documented as legacy / ignored for realtime-worker execution.
- Reviewer model remains Codex/GPT.

### 4) Documentation
Update docs to match reality:
- `docs/ARCHITECTURE.md`
- `docs/tools.md`
- `docs/DEVELOPMENT.md`
- any comments in source files that still describe the old Tier 1 SDK worker path as primary

## Non-goals for this change
- Removing Tier 0
- Replacing Codex CLI reviewer
- Full ACP redesign
- Rewriting `claude-realtime.sh` from scratch
- General OpenClaw model/config cleanup outside the harness path

## Validation plan

### Functional
1. Tier 0 task still returns direct execution response
2. Tier 1 coding task launches realtime worker instead of Claude SDK session worker
3. Review still runs via Codex CLI
4. Fix loop reuses realtime worker path instead of Claude SDK fix session
5. Tier 2 still works with same realtime worker path

### Artifact / behavior checks
- checkpoint files under `/tmp/harness/...`
- realtime state under `/tmp/claude-realtime/...`
- no new Tier 1 worker sessions through the Claude SDK path
- docs no longer claim Tier 1 worker = harness worker / Claude SDK session

## Migration note

This is a unification change, not a net-new worker. The intended result is:
- fewer runtimes
- simpler policy surface
- simpler debugging
- one Claude worker path + one Codex reviewer path
