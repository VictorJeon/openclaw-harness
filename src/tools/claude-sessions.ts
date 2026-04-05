import { Type } from "@sinclair/typebox";
import {
  sessionManager,
  formatSessionListing,
  resolveAgentChannel,
  isLegacyToolsEnabled,
  legacyToolDisabledResult,
} from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeSessionsTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "harness_sessions",
    description:
      "[LEGACY] List all Claude Code sessions with their status and progress. Used to monitor sessions launched via harness_launch. For tasks executed through harness_execute, status is returned directly in the result.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("failed"),
          ],
          { description: 'Filter by status (default "all")' },
        ),
      ),
      // Uncomment to allow agents to see all sessions across agents:
      // scope: Type.Optional(
      //   Type.Union(
      //     [Type.Literal("mine"), Type.Literal("all")],
      //     { description: 'Scope: "mine" (default) shows only this agent\'s sessions, "all" shows every session.' },
      //   ),
      // ),
    }),
    async execute(_id: string, params: any) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_sessions");
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

      const filter = params.status || "all";
      const allSessions = sessionManager.list(filter);

      // Filter by agent ownership (always applied when context is available).
      // To re-enable scope: "all", uncomment the scope parameter above and use:
      // const scope = params.scope || "mine";
      // if (scope === "mine") { ... }
      let sessions = allSessions;
      const agentId = ctx?.agentId;
      if (agentId) {
        // Primary: match by originAgentId
        console.log(`[claude_sessions] Filtering sessions by agentId=${agentId}`);
        sessions = allSessions.filter(s => s.originAgentId === agentId);
      } else if (ctx?.workspaceDir) {
        // Fallback: match by originChannel via workspace lookup
        const agentChannel = resolveAgentChannel(ctx.workspaceDir);
        if (agentChannel) {
          console.log(`[claude_sessions] Filtering sessions by agentChannel=${agentChannel}`);
          sessions = allSessions.filter(s => s.originChannel === agentChannel);
        } else {
          console.log(`[claude_sessions] No agentChannel found for workspaceDir=${ctx.workspaceDir}, returning all sessions`);
        }
      }
      // If neither agentId nor workspaceDir: show all (backward compat for commands/gateway)

      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sessions found.",
            },
          ],
        };
      }

      const lines = sessions.map(formatSessionListing);

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n\n"),
          },
        ],
      };
    },
  };
}
