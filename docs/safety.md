# Safety & Pre-Launch Checks — Legacy Path

> This document is **legacy-only**.
>
> It applies to the direct-session surface (`harness_launch`, `/harness`, related legacy tools).
> It does **not** describe the primary `harness_execute` path.

## What this doc covers

The legacy direct-session surface can run pre-launch guards such as:
- autonomy skill presence
- heartbeat configuration
- HEARTBEAT.md content
- channel mapping

These guards matter only if you are still using the old direct-session flow.

## What to use for new coding work

Use **`harness_execute`** instead.

That path is the current primary surface and manages its own worker lifecycle internally.

## When to read this doc

Read this only if you are:
- debugging old `/harness*` behavior
- maintaining legacy direct PTY sessions
- investigating launch-time guard failures on the legacy surface

If you are working on the main harness path, start with:
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `docs/tools.md`
