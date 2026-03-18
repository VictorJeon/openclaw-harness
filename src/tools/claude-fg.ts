import { Type } from "@sinclair/typebox";
import { sessionManager, formatDuration, resolveOriginChannel, resolveAgentChannel } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeFgTool(ctx?: OpenClawPluginToolContext) {
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
  console.log(`[claude-fg] Factory context: messageChannel=${ctx?.messageChannel}, agentAccountId=${ctx?.agentAccountId}, workspaceDir=${ctx?.workspaceDir}, fallbackChannel=${fallbackChannel}`);

  return {
    name: "claude_fg",
    description:
      "Bring a Claude Code session to foreground (by name or ID). Shows buffered output and streams new output.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session name or ID to bring to foreground",
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of recent buffered lines to show (default 30)",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
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

      // Mark this conversation as a foreground channel
      let channelId = resolveOriginChannel({ id: _id }, fallbackChannel);
      console.log(`[claude-fg] channelId resolved: ${channelId}, session.workdir=${session.workdir}`);

      // If resolveOriginChannel couldn't determine a real channel (returned "unknown"),
      // use the session's stored originChannel (resolved from the agent's workspace at
      // creation time). This avoids re-resolving from session.workdir, which may not
      // match any agentChannels entry (the session workdir is where Claude Code runs,
      // not necessarily the agent's workspace).
      if (channelId === "unknown" && session.originChannel && session.originChannel !== "unknown") {
        channelId = session.originChannel;
      }

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
          : (session.getOutput(params.lines ?? 30).length > 0
              ? session.getOutput(params.lines ?? 30).join("\n")
              : "(no output yet)");

      const footer =
        session.status === "running" || session.status === "starting"
          ? `\n${"─".repeat(60)}\nStreaming new output... Use claude_bg to detach.`
          : `\n${"─".repeat(60)}\nSession is ${session.status}. No more output expected.`;

      // Mark that this channel has now seen all output up to this point
      session.markFgOutputSeen(channelId);

      return {
        content: [
          {
            type: "text",
            text: `${header}\n${body}${footer}`,
          },
        ],
      };
    },
  };
}
