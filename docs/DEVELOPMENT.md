# Development

## Project layout

```txt
openclaw-harness/
├── index.ts
├── openclaw.plugin.json
├── package.json
├── src/
│   ├── backend/
│   │   ├── factory.ts
│   │   ├── local-cc.ts
│   │   ├── remote-realtime.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── checkpoint.ts
│   ├── planner.ts
│   ├── review-loop.ts
│   ├── reviewer.ts
│   ├── router.ts
│   ├── session-manager.ts
│   ├── session.ts
│   ├── shared.ts
│   ├── tools/
│   │   ├── harness-execute.ts        # primary path
│   │   ├── claude-launch.ts          # legacy
│   │   ├── claude-sessions.ts        # legacy
│   │   ├── claude-output.ts          # legacy
│   │   ├── claude-fg.ts              # legacy
│   │   ├── claude-bg.ts              # legacy
│   │   ├── claude-kill.ts            # legacy
│   │   ├── claude-respond.ts         # legacy
│   │   └── claude-stats.ts
│   └── commands/
│       └── claude*.ts                # legacy chat-command surface
└── docs/
```

---

## Where to change what

### Routing / decomposition
- `src/router.ts`
- `src/planner.ts`

### Backend seam definitions
- `src/backend/*`
- `src/types.ts`
- `src/shared.ts`
- `openclaw.plugin.json`

### Review / fix loop behavior
- `src/review-loop.ts`
- `src/tools/harness-execute.ts`

### Tier 2 realtime behavior
- `src/tools/harness-execute.ts`
- external helper script: `~/.openclaw/workspace-nova/scripts/claude-realtime.sh`
- sync helper: `~/.openclaw/workspace-nova/scripts/git-sync.sh`

### Legacy direct-session behavior
- `src/session.ts`
- `src/session-manager.ts`
- `src/tools/claude-*.ts`
- `src/commands/claude-*.ts`

---

## Current implementation notes

### Tier 1
- `claude-realtime.sh` worker on Hetzner
- Codex CLI review
- realtime follow-up fixes continue in same worker session

### Tier 2
- same `claude-realtime.sh` worker path as Tier 1
- embedded caller-agent plan review
- local sync-back before Codex review
- completed realtime worker results recover on resume

### Backend migration note
- phase 1 adds `workerBackend` config + `src/backend/*` seam only
- runtime dispatch still stays on the current realtime worker path
- later phases will move execution dispatch onto the backend factory

### Planner behavior
- planner is deterministic; do not assume a hidden model call here
- common single-feature workflows should usually stay one task
- avoid reintroducing over-decomposition for tiny coding requests

---

## Build / reload

```bash
cd /Users/nova/.openclaw/extensions/openclaw-harness
npm run build
openclaw gateway restart
```

Notes:
- docs-only edits do **not** require a restart
- plugin code edits do require restart after rebuild
- treat gateway restart as expensive; batch changes when possible

---

## Validation habits

When changing harness behavior, prefer direct proof over inference:
- inspect checkpoint files in `/tmp/harness/.../checkpoint.json`
- inspect realtime state in `/tmp/claude-realtime/...`
- verify repo state with `git log`, file reads, and tests
- do at least one fresh smoke for the changed path

Typical smoke patterns:
- **tier 1**: small repo + realtime worker launch + Codex review + one follow-up fix
- **tier 2**: realtime repo + embedded plan review + same-session follow-up + final Codex review

---

## Documentation maintenance rule

If you change any of these, update docs in the same PR/commit set:
- tier routing rules
- planner decomposition rules
- whether router/planner are deterministic vs model-driven
- review loop behavior
- worker/reviewer model choice
- legacy vs primary execution guidance
