import {
  sessionManager,
  formatDuration,
  resolveOriginChannel,
  isLegacyToolsEnabled,
  legacyCommandDisabledResult,
} from "../shared";

export function registerClaudeFgCommand(api: any): void {
  api.registerCommand({
    name: "harness_fg",
    description: "[LEGACY] Bring a Claude Code session to foreground by name or ID (for sessions launched via /harness or harness_launch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_fg");
      }

      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      const ref = ctx.args?.trim();
      if (!ref) {
        return { text: "Usage: /harness_fg <name-or-id>" };
      }

      const session = sessionManager.resolve(ref);
      if (!session) {
        return { text: `Error: Session "${ref}" not found.` };
      }

      // Mark as foreground using the resolved channel (e.g. "telegram|123456")
      const channelId = resolveOriginChannel(ctx);

      // Get catchup output (produced while this channel was backgrounded)
      const catchupLines = session.getCatchupOutput(channelId);

      session.foregroundChannels.add(channelId);

      const duration = formatDuration(session.duration);

      const header = [
        `Session ${session.name} [${session.id}] now in foreground.`,
        `Status: ${session.status.toUpperCase()} | Duration: ${duration}`,
        `${"─".repeat(60)}`,
      ].join("\n");

      // Build catchup section if there's missed output
      let catchupSection = "";
      if (catchupLines.length > 0) {
        catchupSection = [
          `📋 Catchup (${catchupLines.length} missed output${catchupLines.length === 1 ? "" : "s"}):`,
          catchupLines.join("\n"),
          `${"─".repeat(60)}`,
        ].join("\n");
      }

      // If no catchup, fall back to showing recent lines
      const body =
        catchupLines.length > 0
          ? catchupSection
          : (session.getOutput(30).length > 0
              ? session.getOutput(30).join("\n")
              : "(no output yet)");

      const footer =
        session.status === "running" || session.status === "starting"
          ? `\n${"─".repeat(60)}\nStreaming... Use /harness_bg to detach.`
          : `\n${"─".repeat(60)}\nSession is ${session.status}.`;

      // Mark that this channel has now seen all output up to this point
      session.markFgOutputSeen(channelId);

      return { text: `${header}\n${body}${footer}` };
    },
  });
}
