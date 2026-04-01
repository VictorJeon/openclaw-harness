# Development

## Project layout

```txt
openclaw-harness/
├── index.ts
├── openclaw.plugin.json
├── package.json
├── src/
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
- harness worker path
- Codex ACP review
- persistent named reviewer sessions per plan/task
- review/fix/re-review continuity validated

### Tier 2
- `claude-realtime.sh` worker on Hetzner
- embedded caller-agent plan review
- local sync-back before Codex review
- realtime follow-up fixes continue in same worker session
- completed realtime worker results recover on resume

### Planner behavior
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
- **tier 1**: small repo + CLAUDE.md rule that should trigger at least one review fix
- **tier 2**: realtime repo + same-session follow-up + final Codex review

---

## Documentation maintenance rule

If you change any of these, update docs in the same PR/commit set:
- tier routing rules
- planner decomposition rules
- review loop behavior
- worker/reviewer model choice
- legacy vs primary execution guidance
