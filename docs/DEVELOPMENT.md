# Development

## Project Structure

```
claude-code/
├── index.ts                    # Plugin entry point (register function)
├── openclaw.plugin.json        # Plugin manifest and config schema
├── package.json                # Dependencies
├── src/
│   ├── types.ts                # TypeScript interfaces
│   ├── shared.ts               # Global state, helpers, formatting
│   ├── session.ts              # Session class (SDK wrapper)
│   ├── session-manager.ts      # Session pool management
│   ├── notifications.ts        # NotificationRouter
│   ├── gateway.ts              # RPC method registration
│   ├── router.ts               # Tier classifier for harness_execute
│   ├── planner.ts              # Task decomposer for harness_execute
│   ├── reviewer.ts             # Review output parser for harness_execute
│   ├── review-loop.ts          # Review-fix loop orchestrator
│   ├── checkpoint.ts           # Checkpoint persistence for harness_execute
│   ├── tools/
│   │   ├── harness-execute.ts  # harness_execute tool (PRIMARY — Plan-Work-Review)
│   │   ├── claude-launch.ts    # harness_launch tool [LEGACY — direct PTY session]
│   │   ├── claude-sessions.ts  # harness_sessions tool [LEGACY]
│   │   ├── claude-output.ts    # harness_output tool [LEGACY]
│   │   ├── claude-fg.ts        # harness_fg tool [LEGACY]
│   │   ├── claude-bg.ts        # harness_bg tool [LEGACY]
│   │   ├── claude-kill.ts      # harness_kill tool [LEGACY]
│   │   ├── claude-respond.ts   # harness_respond tool [LEGACY]
│   │   └── claude-stats.ts     # harness_stats tool (covers all paths)
│   └── commands/
│       ├── claude.ts           # /harness command [LEGACY — direct session]
│       ├── claude-sessions.ts  # /harness_sessions command [LEGACY]
│       ├── claude-fg.ts        # /harness_fg command [LEGACY]
│       ├── claude-bg.ts        # /harness_bg command [LEGACY]
│       ├── claude-kill.ts      # /harness_kill command [LEGACY]
│       ├── claude-resume.ts    # /harness_resume command [LEGACY]
│       ├── claude-respond.ts   # /harness_respond command [LEGACY]
│       └── claude-stats.ts     # /harness_stats command (covers all paths)
├── skills/
│   └── claude-code-orchestration/
│       └── SKILL.md            # Orchestration skill definition
└── docs/
    ├── API.md                  # Full API reference
    ├── ARCHITECTURE.md         # Architecture overview (primary vs legacy paths)
    ├── NOTIFICATIONS.md        # Notification system details
    ├── safety.md               # Pre-launch safety checks (legacy harness_launch path)
    └── DEVELOPMENT.md          # This file
```

### Primary vs Legacy paths

`harness_execute` is the **primary** execution path. It classifies complexity (tier 0/1/2), decomposes the request into tasks, dispatches workers (via `runtime.subagent.run` or `sessionManager.spawn` fallback), and runs a cross-model review loop. Results are returned directly as structured output.

The `harness_launch` tool and `/harness*` commands form the **legacy direct-session surface**. They provide raw PTY access to Claude Code sessions and are still appropriate for interactive/multi-turn use cases. They are not the recommended path for new automated coding tasks.

---

## Dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | Claude Code SDK — the `query()` function that powers each session. |
| `@sinclair/typebox` | JSON Schema type builder for tool parameter definitions. |
| `nanoid` | Generates short unique session IDs (8 characters). |

---

## Key Design Decisions

1. **Foreground is per-channel, not per-session.** Multiple channels can watch the same session simultaneously, and one channel can have multiple sessions in foreground.

2. **Multi-turn uses `AsyncIterable` prompts.** The `MessageStream` class implements `Symbol.asyncIterator` to feed user messages into the SDK's `query()` function as an async generator, keeping the session alive across turns.

3. **Persisted sessions survive GC.** When a session is garbage-collected (1 hour after completion), its Claude session ID is retained in a separate `persistedSessions` map so it can be resumed later. Entries are stored under three keys (internal ID, name, Claude UUID) for flexible lookup.

4. **Notifications use CLI shelling.** Since the plugin API doesn't expose a runtime `sendMessage` method, outbound notifications go through `openclaw message send` via `child_process.execFile`.

5. **Metrics are in-memory only.** Session metrics are aggregated in the `SessionManager` and reset on service restart. They are not persisted to disk. Cost data is tracked internally but not exposed in any user-facing output.

6. **Waiting-for-input uses dual detection.** End-of-turn detection (when a multi-turn result resolves) is the primary signal, backed by a 15-second safety-net timer for edge cases. A `waitingForInputFired` flag prevents duplicate wake events.

7. **Channel `"unknown"` falls through.** If `channelId` is `"unknown"`, the notification system explicitly falls through to `fallbackChannel` rather than attempting delivery to an invalid destination.

---

## Adding a New Tool or Command

1. Create a new file under `src/tools/` or `src/commands/`.
2. Export a `registerXxxTool(api)` or `registerXxxCommand(api)` function.
3. Import and call it in `index.ts` inside the `register()` function.

---

## Service Lifecycle

- **`start()`** — Creates `SessionManager` and `NotificationRouter`, wires them together, starts the long-running reminder check interval (60s), and starts a GC interval (5 min).
- **`stop()`** — Stops the notification router, kills all active sessions, clears intervals, and nulls singletons.
