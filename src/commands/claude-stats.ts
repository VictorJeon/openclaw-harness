import { sessionManager, formatStats } from "../shared";

export function registerClaudeStatsCommand(api: any): void {
  api.registerCommand({
    name: "harness_stats",
    description: "Show Claude Code Plugin usage metrics",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      const metrics = sessionManager.getMetrics();
      return { text: formatStats(metrics) };
    },
  });
}
