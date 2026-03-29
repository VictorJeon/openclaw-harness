import { sessionManager } from "../shared";

export function registerClaudeKillCommand(api: any): void {
  api.registerCommand({
    name: "harness_kill",
    description: "Kill a Claude Code session by name or ID",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      const ref = ctx.args?.trim();
      if (!ref) {
        return { text: "Usage: /claude_kill <name-or-id>" };
      }

      const session = sessionManager.resolve(ref);

      if (!session) {
        return { text: `Error: Session "${ref}" not found.` };
      }

      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "killed"
      ) {
        return {
          text: `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.`,
        };
      }

      sessionManager.kill(session.id);

      return { text: `Session ${session.name} [${session.id}] has been terminated.` };
    },
  });
}
