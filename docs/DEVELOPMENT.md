# Development

> Last updated: 2026-04-10

## Project layout

```
openclaw-harness/
├── index.ts                          # Plugin entry + GC (stale cleanup)
├── openclaw.plugin.json              # Schema + config defaults
├── package.json
├── src/
│   ├── tools/
│   │   └── harness-execute.ts        # Primary: async orchestration + heartbeat
│   ├── router.ts                     # 3-layer: pattern → keyword → LLM
│   ├── planner.ts                    # Model-backed task decomposition
│   ├── reviewer-consensus.ts         # Parallel Codex + GLM consensus
│   ├── meta-reviewer.ts             # Escalation mediation
│   ├── reviewer-runner.ts            # Codex CLI wrapper (session resume)
│   ├── reviewer-openrouter.ts        # OpenRouter API wrapper (GLM secondary)
│   ├── reviewer.ts                   # Review prompt + parse + severity filter
│   ├── review-loop.ts               # Fix cycle state machine
│   ├── gap-types.ts                  # 5-type taxonomy + severity weights
│   ├── checkpoint.ts                 # Persistence + stale cleanup
│   ├── model-resolution.ts           # Model alias resolution
│   ├── workspace-isolation.ts         # Git clone for dirty worktrees
│   ├── shared.ts                     # Global state + config proxy
│   ├── types.ts                      # All type definitions
│   ├── backend/
│   │   ├── factory.ts                # Backend selection
│   │   ├── remote-realtime.ts        # Hetzner worker
│   │   ├── local-cc.ts              # Local Claude CLI worker
│   │   └── types.ts                  # Backend interfaces
│   ├── session.ts                    # Legacy session lifecycle
│   ├── session-manager.ts            # Legacy session pool
│   ├── notifications.ts              # NotificationRouter
│   ├── gateway.ts                    # RPC methods
│   └── tools/claude-*.ts + commands/ # Legacy surface
├── tests/run.js                      # 40 tests
└── docs/
```

## Where to change what

| Area | Files |
|------|-------|
| Tier routing | `router.ts` |
| Task decomposition | `planner.ts` |
| Async execution + heartbeat | `tools/harness-execute.ts` |
| Reviewer consensus | `reviewer-consensus.ts` + `reviewer-openrouter.ts` |
| Meta-reviewer | `meta-reviewer.ts` |
| Review loop + session continuity | `review-loop.ts` + `reviewer-runner.ts` |
| Gap severity | `gap-types.ts` + `reviewer.ts` |
| Stale cleanup | `checkpoint.ts` + `index.ts` |
| Config schema | `openclaw.plugin.json` + `types.ts` + `shared.ts` (all 3 required) |

## Build / reload

```bash
npm run build && openclaw gateway restart
```

## Test

```bash
npm run test    # 40 tests
```
