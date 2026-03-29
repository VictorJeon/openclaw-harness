import { sessionManager, resolveOriginChannel, formatDuration } from "../shared";

export function registerClaudeResumeCommand(api: any): void {
  api.registerCommand({
    name: "harness_resume",
    description:
      "Resume a previous Claude Code session. Usage: /claude_resume <id-or-name> [prompt] or /claude_resume --list to see resumable sessions.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      let args = (ctx.args ?? "").trim();
      if (!args) {
        return {
          text: "Usage: /claude_resume <id-or-name> [prompt]\n       /claude_resume --list — list resumable sessions\n       /claude_resume --fork <id-or-name> [prompt] — fork instead of continuing",
        };
      }

      // Handle --list flag
      if (args === "--list") {
        const persisted = sessionManager.listPersistedSessions();
        if (persisted.length === 0) {
          return { text: "No resumable sessions found. Sessions are persisted after completion." };
        }

        const lines = persisted.map((info) => {
          const promptSummary =
            info.prompt.length > 60
              ? info.prompt.slice(0, 60) + "..."
              : info.prompt;
          const completedStr = info.completedAt
            ? `completed ${formatDuration(Date.now() - info.completedAt)} ago`
            : info.status;
          return [
            `  ${info.name} — ${completedStr}`,
            `    Claude ID: ${info.claudeSessionId}`,
            `    📁 ${info.workdir}`,
            `    📝 "${promptSummary}"`,
          ].join("\n");
        });

        return {
          text: `Resumable sessions:\n\n${lines.join("\n\n")}`,
        };
      }

      // Parse --fork flag
      let fork = false;
      if (args.startsWith("--fork ")) {
        fork = true;
        args = args.slice("--fork ".length).trim();
      }

      // Parse: first word is the session ref, rest is the prompt
      const spaceIdx = args.indexOf(" ");
      let ref: string;
      let prompt: string;
      if (spaceIdx === -1) {
        ref = args;
        prompt = "Continue where you left off.";
      } else {
        ref = args.slice(0, spaceIdx);
        prompt = args.slice(spaceIdx + 1).trim() || "Continue where you left off.";
      }

      // Resolve the Claude session ID
      const claudeSessionId = sessionManager.resolveClaudeSessionId(ref);
      if (!claudeSessionId) {
        return {
          text: `Error: Could not find a Claude session ID for "${ref}".\nUse /claude_resume --list to see available sessions.`,
        };
      }

      const config = ctx.config ?? {};

      // Look up persisted info for workdir
      const persisted = sessionManager.getPersistedSession(ref);
      const workdir = persisted?.workdir ?? process.cwd();

      try {
        const session = sessionManager.spawn({
          prompt,
          workdir,
          model: persisted?.model ?? config.defaultModel,
          maxBudgetUsd: config.defaultBudgetUsd ?? 5,
          resumeSessionId: claudeSessionId,
          forkSession: fork,
          originChannel: resolveOriginChannel(ctx),
          deliverChannel: persisted?.deliverChannel,
        });

        const promptSummary =
          prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;

        return {
          text: [
            `Session resumed${fork ? " (forked)" : ""}.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            `  Resume from: ${claudeSessionId}`,
            `  Dir: ${workdir}`,
            `  Prompt: "${promptSummary}"`,
          ].join("\n"),
        };
      } catch (err: any) {
        return { text: `Error: ${err.message}` };
      }
    },
  });
}
