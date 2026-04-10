# Notification System

> Last updated: 2026-04-10

## Harness notifications (primary)

### Heartbeat
During async worker execution, progress is pushed directly to Telegram:
- **20 seconds**: first heartbeat after worker launch
- **30 seconds**: subsequent intervals
- Format: `⏳ <jobId-tail> | <status> | round <N> | <elapsed>s`
- Sent via `openclaw message send` CLI

### Completion push
When the background pipeline finishes, the full result is pushed to Telegram:
- On success: `완료 — plan <id>\n\n<formatted result>`
- On failure: `하네스 실패 — plan <id>: <error>`
- Max 4000 chars per message

### Channel resolution
- Resolved from `ctx.messageChannel` (tool invocation context)
- Fallback: `pluginConfig.fallbackChannel`
- If channel is "unknown" or undefined, notifications are logged but not sent

---

## Legacy session notifications

Applies to legacy direct-session tools (`harness_launch`, etc.) only.

| Emoji | Event | When |
|-------|-------|------|
| ↩️ | Launched | Session started |
| 🔔 | Claude asks | Waiting for input |
| ✅ | Completed | Session finished |
| ❌ | Failed | Session error |
| ⛔ | Killed | Session terminated |

---

## agentChannels config

Map workspace paths to notification targets:
```json
{
  "agentChannels": {
    "/Users/nova/.openclaw/workspace-nova": "telegram|default|819845604",
    "/Users/nova/.openclaw/workspace-bolt": "telegram|bolt|819845604"
  }
}
```
