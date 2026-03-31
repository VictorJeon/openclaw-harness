import { Type } from "@sinclair/typebox";
import { sessionManager, formatStats } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeStatsTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "harness_stats",
    description:
      "[LEGACY] Show Claude Code Plugin usage metrics: session counts by status, average duration, and notable sessions. Covers all sessions — both harness_execute (primary path) and harness_launch (LEGACY direct path). For new coding work, prefer harness_execute.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
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

      const metrics = sessionManager.getMetrics();
      const text = formatStats(metrics);

      return {
        content: [{ type: "text", text }],
      };
    },
  };
}
