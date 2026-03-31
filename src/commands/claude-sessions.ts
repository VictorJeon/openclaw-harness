import { sessionManager, formatSessionListing } from "../shared";

export function registerClaudeSessionsCommand(api: any): void {
  api.registerCommand({
    name: "harness_sessions",
    description: "[LEGACY] List all Claude Code sessions (for sessions launched via /harness or harness_launch)",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      const sessions = sessionManager.list("all");

      if (sessions.length === 0) {
        return { text: "No sessions found." };
      }

      const lines = sessions.map(formatSessionListing);

      return { text: lines.join("\n\n") };
    },
  });
}
