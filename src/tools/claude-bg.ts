import { Type } from "@sinclair/typebox";
import {
  sessionManager,
  resolveOriginChannel,
  resolveAgentChannel,
  hasValidOriginChannel,
  isLegacyToolsEnabled,
  legacyToolDisabledResult,
} from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeBgTool(ctx?: OpenClawPluginToolContext) {
  // Build channel from factory context if available.
  // Priority: 1) ctx.messageChannel with injected accountId
  //           2) resolveAgentChannel(ctx.workspaceDir) from agentChannels config
  //           3) ctx.messageChannel as-is (if it already has |)
  let fallbackChannel: string | undefined;
  if (ctx?.messageChannel && ctx?.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      fallbackChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
  }
  if (!fallbackChannel && ctx?.workspaceDir) {
    fallbackChannel = resolveAgentChannel(ctx.workspaceDir);
  }
  if (!fallbackChannel && ctx?.messageChannel && ctx.messageChannel.includes("|")) {
    fallbackChannel = ctx.messageChannel;
  }
  console.log(`[claude-bg] Factory context: messageChannel=${ctx?.messageChannel}, agentAccountId=${ctx?.agentAccountId}, workspaceDir=${ctx?.workspaceDir}, fallbackChannel=${fallbackChannel}`);

  return {
    name: "harness_bg",
    description:
      "[LEGACY] Send a Claude Code session back to background (stop streaming). If no session specified, detaches whichever session is currently in foreground. Only applies to sessions launched via harness_launch.",
    parameters: Type.Object({
      session: Type.Optional(
        Type.String({
          description:
            "Session name or ID to send to background. If omitted, detaches the current foreground session.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_bg");
      }

      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running.",
            },
          ],
        };
      }

      // If a specific session is given, detach it
      if (params.session) {
        const session = sessionManager.resolve(params.session, ctx?.agentId);
        if (!session) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Session "${params.session}" not found.`,
              },
            ],
          };
        }

        let channelId = resolveOriginChannel({ id: _id }, fallbackChannel);
        console.log(`[claude-bg] channelId resolved: ${channelId}, session.workdir=${session.workdir}`);
        // Use the session's stored originChannel (resolved from the agent's workspace
        // at creation time) instead of re-resolving from session.workdir.
        if (channelId === "unknown" && hasValidOriginChannel(session)) {
          channelId = session.originChannel;
        }
        session.saveFgOutputOffset(channelId);
        session.foregroundChannels.delete(channelId);
        return {
          content: [
            {
              type: "text",
              text: `Session ${session.name} [${session.id}] moved to background.`,
            },
          ],
        };
      }

      // No session specified — find any session that has this channel in foreground
      let resolvedId = resolveOriginChannel({ id: _id }, fallbackChannel);
      console.log(`[claude-bg] resolvedId (no session): ${resolvedId}`);
      if (resolvedId === "unknown") {
        // Try each session's stored originChannel (resolved from the agent's workspace
        // at creation time) to find one with a matching foreground channel.
        const allSessionsForLookup = sessionManager.list("all");
        for (const s of allSessionsForLookup) {
          if (hasValidOriginChannel(s) && s.foregroundChannels.has(s.originChannel!)) {
            resolvedId = s.originChannel;
            break;
          }
        }
      }
      const allSessions = sessionManager.list("all");
      const fgSessions = allSessions.filter((s) =>
        s.foregroundChannels.has(resolvedId),
      );

      if (fgSessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No session is currently in foreground.",
            },
          ],
        };
      }

      const names: string[] = [];
      for (const s of fgSessions) {
        s.saveFgOutputOffset(resolvedId);
        s.foregroundChannels.delete(resolvedId);
        names.push(`${s.name} [${s.id}]`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Moved to background: ${names.join(", ")}`,
          },
        ],
      };
    },
  };
}
