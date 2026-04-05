# Two-backend migration plan

## Goal

Keep `openclaw-harness` as **one repo** while supporting two worker backends:

- `remote-realtime` — current default / stable lane for Nova-internal use
- `local-cc` — future opt-in / public lane for portable installs

The immediate goal is to create a backend seam without changing runtime behavior.

## Backend lanes

### `remote-realtime`
- current production path
- launches `claude-realtime.sh`
- remains the default in phase 1
- must stay behavior-compatible during the migration

### `local-cc`
- future local-first path
- intended for local Claude Code CLI execution plus local review flows
- opt-in only until the path is implemented and proven

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

Phase 1 adds only the seam:

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
- `local-cc` implements them as fail-safe stubs that throw a clear "not yet implemented" error
- `executeTask()` resolves a backend via `resolveWorkerBackend(pluginConfig)` for tier 1+ tasks
- Tier 0 tasks are completely unaffected (they never enter backend dispatch)
- Default backend remains `remote-realtime` — no config change required

### Dispatch flow after phase 2

```
executeTask(task, plan, ...)
  tier 0  → sessionManager.spawn fallback (unchanged)
  tier 1+ → backend = resolveWorkerBackend(pluginConfig)
            backend.executeWorker(ctx)      // initial worker launch
            backend.continueWorker(ctx, fb) // fix feedback (review loop)
            backend.finalizeWorker(ctx)     // review passed, finalize
```

### What happens with workerBackend=local-cc

`resolveWorkerBackend()` returns the `localCcBackend` handler. Any execution method
throws: `"local-cc worker backend is not yet implemented"`. The error is caught by
`executeTask`'s existing error handler and reported as a structured task failure.

## Future phases

### Phase 3
- implement the real `local-cc` execution path
- move realtime helper functions into `remote-realtime.ts` (currently they remain in `harness-execute.ts`)
- add backend-specific validation and smoke coverage
- decide when/if the public default should move

## Review rule

Phase-1 rule: if changes alter runtime behavior, the seam is too large.
Phase-2 rule: `remote-realtime` behavior must remain identical — the dispatch indirection
must be transparent. Only `local-cc` selection should produce new (error) behavior.
