import { sessionManager, formatStats } from "../shared";

export function registerClaudeStatsCommand(api: any): void {
  api.registerCommand({
    name: "harness_stats",
    description: "[LEGACY] Show Claude Code Plugin usage metrics (covers both harness_execute primary path and harness_launch LEGACY path). Part of the direct-session surface — for new coding tasks prefer harness_execute.",
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
