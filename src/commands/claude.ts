import { sessionManager, pluginConfig, resolveOriginChannel } from "../shared";

export function registerClaudeCommand(api: any): void {
  api.registerCommand({
    name: "harness",
    description: "[LEGACY] Launch a Claude Code session directly. For coding tasks with planning and review, use harness_execute instead. Usage: /harness [--name <name>] <prompt>",
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
        return { text: "Usage: /harness [--name <name>] <prompt>" };
      }

      // Parse optional --name flag
      let name: string | undefined;
      const nameMatch = args.match(/^--name\s+(\S+)\s+/);
      if (nameMatch) {
        name = nameMatch[1];
        args = args.slice(nameMatch[0].length).trim();
      }

      const prompt = args;
      if (!prompt) {
        return { text: "Usage: /harness [--name <name>] <prompt>" };
      }

      try {
        const session = sessionManager.spawn({
          prompt,
          name,
          workdir: pluginConfig.defaultWorkdir || process.cwd(),
          model: pluginConfig.defaultModel,
          maxBudgetUsd: pluginConfig.defaultBudgetUsd ?? 5,
          originChannel: resolveOriginChannel(ctx),
        });

        const promptSummary =
          prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;

        return {
          text: [
            `Session launched.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            `  Prompt: "${promptSummary}"`,
            `  Status: ${session.status}`,
          ].join("\n"),
        };
      } catch (err: any) {
        return { text: `Error: ${err.message}` };
      }
    },
  });
}
