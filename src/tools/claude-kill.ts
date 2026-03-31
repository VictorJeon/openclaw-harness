import { Type } from "@sinclair/typebox";
import { sessionManager } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeKillTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "harness_kill",
    description: "[LEGACY] Terminate a running Claude Code session by name or ID. Used for sessions launched via harness_launch. harness_execute manages its own session lifecycle internally.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to terminate" }),
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

      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "killed"
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.`,
            },
          ],
        };
      }

      sessionManager.kill(session.id);

      return {
        content: [
          {
            type: "text",
            text: `Session ${session.name} [${session.id}] has been terminated.`,
          },
        ],
      };
    },
  };
}
