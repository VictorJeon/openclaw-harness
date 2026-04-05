import {
  sessionManager,
  resolveOriginChannel,
  isLegacyToolsEnabled,
  legacyCommandDisabledResult,
} from "../shared";

export function registerClaudeBgCommand(api: any): void {
  api.registerCommand({
    name: "harness_bg",
    description: "[LEGACY] Send the current foreground session back to background (for sessions launched via /harness or harness_launch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_bg");
      }

      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      const channelId = resolveOriginChannel(ctx);

      // If a specific session is given, detach it
      const ref = ctx.args?.trim();
      if (ref) {
        const session = sessionManager.resolve(ref);
        if (!session) {
          return { text: `Error: Session "${ref}" not found.` };
        }
        session.saveFgOutputOffset(channelId);
        session.foregroundChannels.delete(channelId);
        return {
          text: `Session ${session.name} [${session.id}] moved to background.`,
        };
      }

      // No argument — detach all foreground sessions for this channel
      const allSessions = sessionManager.list("all");
      const fgSessions = allSessions.filter((s) =>
        s.foregroundChannels.has(channelId),
      );

      if (fgSessions.length === 0) {
        return { text: "No session is currently in foreground." };
      }

      const names: string[] = [];
      for (const s of fgSessions) {
        s.saveFgOutputOffset(channelId);
        s.foregroundChannels.delete(channelId);
        names.push(`${s.name} [${s.id}]`);
      }

      return { text: `Moved to background: ${names.join(", ")}` };
    },
  });
}
