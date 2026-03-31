import { sessionManager } from "../shared";

export function registerClaudeRespondCommand(api: any): void {
  api.registerCommand({
    name: "harness_respond",
    description:
      "[LEGACY] Send a follow-up message to a running Claude Code session launched via /harness or harness_launch. Usage: /harness_respond <id-or-name> <message>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running.",
        };
      }

      const args = (ctx.args ?? "").trim();
      if (!args) {
        return {
          text: "Usage: /harness_respond <id-or-name> <message>\n       /harness_respond --interrupt <id-or-name> <message>",
        };
      }

      // Parse optional --interrupt flag
      let interrupt = false;
      let remaining = args;
      if (remaining.startsWith("--interrupt ")) {
        interrupt = true;
        remaining = remaining.slice("--interrupt ".length).trim();
      }

      // Parse: first word is the session ref, rest is the message
      const spaceIdx = remaining.indexOf(" ");
      if (spaceIdx === -1) {
        return {
          text: "Error: Missing message. Usage: /harness_respond <id-or-name> <message>",
        };
      }

      const ref = remaining.slice(0, spaceIdx);
      const message = remaining.slice(spaceIdx + 1).trim();

      if (!message) {
        return {
          text: "Error: Empty message. Usage: /harness_respond <id-or-name> <message>",
        };
      }

      const session = sessionManager.resolve(ref);
      if (!session) {
        return { text: `Error: Session "${ref}" not found.` };
      }

      if (session.status !== "running") {
        return {
          text: `Error: Session ${session.name} [${session.id}] is not running (status: ${session.status}).`,
        };
      }

      try {
        if (interrupt) {
          await session.interrupt();
        }
        await session.sendMessage(message);

        // Reset auto-respond counter (user-initiated)
        session.resetAutoRespond();

        // Level 1: Send ↩️ Responded notification to Telegram
        if (sessionManager) {
          const respondMsg = [
            `↩️ [${session.name}] Responded:`,
            message.length > 200 ? message.slice(0, 200) + "..." : message,
          ].join("\n");
          sessionManager.deliverToTelegram(session, respondMsg, "responded");
        }

        const msgSummary =
          message.length > 80 ? message.slice(0, 80) + "..." : message;

        return {
          text: [
            `Message sent to ${session.name} [${session.id}].`,
            interrupt ? `  (interrupted current turn)` : "",
            `  "${msgSummary}"`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err: any) {
        return { text: `Error: ${err.message}` };
      }
    },
  });
}
