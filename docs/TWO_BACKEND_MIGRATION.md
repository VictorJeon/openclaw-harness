# Two-backend migration plan

## Goal

Keep `openclaw-harness` as **one repo** while supporting two worker backends:

- `remote-realtime` — current default / stable lane for Nova-internal use
- `local-cc` — opt-in local lane for portable installs

The immediate goal was to create the backend seam without changing runtime behavior.
The current goal is to keep `remote-realtime` as the default while making
`local-cc` usable for local-only execution.

## Backend lanes

### `remote-realtime`
- current production path
- launches `claude-realtime.sh`
- remains the default in phase 1
- must stay behavior-compatible during the migration

### `local-cc`
- local-first path
- uses the local Claude Code CLI in the local workdir
- keeps the existing local Codex reviewer flow
- remains opt-in; it does not change the default backend

## Configuration

Phase 1 introduces a new config key:

```json
{
  "workerBackend": "remote-realtime"
}
```

Allowed values:
- `remote-realtime`
- `local-cc`

Default:
- `remote-realtime`

## Phase 1 scope

Phase 1 added only the seam:

- config/schema support for `workerBackend`
- shared type definitions for backend selection
- a backend factory
- stub modules for both backends
- documentation describing the lane split

Phase 1 explicitly does **not**:

- change `executeTask()` dispatch
- replace the current realtime worker path
- enable `local-cc` execution
- change defaults away from `remote-realtime`

## Phase 2 scope (completed)

Phase 2 connects `executeTask()` dispatch to the backend seam:

- `WorkerBackendHandler` gains execution methods: `executeWorker`, `continueWorker`, `finalizeWorker`
- `remote-realtime` implements these by delegating to the existing realtime helper functions
- `local-cc` initially implemented them as fail-safe stubs that threw a clear "not yet implemented" error
- `executeTask()` resolves a backend via `resolveWorkerBackend(pluginConfig)` for tier 1+ tasks
- Tier 0 tasks are completely unaffected (they never enter backend dispatch)
- Default backend remains `remote-realtime` — no config change required

### Dispatch flow

```
executeTask(task, plan, ...)
  tier 0  → sessionManager.spawn fallback (unchanged)
  tier 1+ → backend = resolveWorkerBackend(pluginConfig)
            backend.executeWorker(ctx)      // initial worker launch
            backend.continueWorker(ctx, fb) // fix feedback (review loop)
            backend.finalizeWorker(ctx)     // review passed, finalize
```

### What happens with workerBackend=local-cc

`resolveWorkerBackend()` returns the `localCcBackend` handler.

Current behavior:
- `executeWorker()` runs a one-shot local `claude` CLI command in the local workdir
- `continueWorker()` runs another one-shot local `claude` CLI command with reviewer feedback
- `finalizeWorker()` marks the local job state done and returns the latest completed worker result
- state is persisted under `/tmp/openclaw-harness-local-cc/<jobId>`
- repeated calls with the same `jobId` reuse completed output instead of rerunning blindly
- reviewer stays on the existing local Codex CLI path
- tier 0 remains unchanged because it never enters backend dispatch

## Phase 3 scope (completed in v1)

- implement the real `local-cc` execution path
- keep default backend = `remote-realtime`
- keep reviewer on the existing local Codex path
- add local `jobId` state reuse
- keep tier 0 behavior unchanged

## Future phases

- move realtime helper functions into `remote-realtime.ts` (currently they remain in `harness-execute.ts`)
- broaden backend-specific smoke coverage
- decide when/if the public default should move

## Review rule

Phase-1 rule: if changes alter runtime behavior, the seam is too large.
Phase-2/3 rule: `remote-realtime` behavior must remain identical — the dispatch indirection
must be transparent for the default lane. Only `local-cc` selection should produce the new local behavior.
