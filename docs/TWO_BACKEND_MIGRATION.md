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

## Future phases

### Phase 2
- switch `executeTask()` dispatch to the backend factory
- keep `remote-realtime` as the default
- keep `local-cc` opt-in only

### Phase 3
- implement the real `local-cc` execution path
- add backend-specific validation and smoke coverage
- decide when/if the public default should move

## Review rule

If phase-1 changes alter runtime behavior, the seam is too large.
The migration stays valid only if current `remote-realtime` behavior remains unchanged.
