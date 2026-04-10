import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nanoid } from "nanoid";
import { resolveModelAlias } from "./model-resolution";
import { REVIEWER_SYSTEM_PROMPT } from "./reviewer";
import type { CodexReasoningEffortLevel } from "./types";

export type ReviewerBackend = "claude-session" | "codex-cli";

export interface ReviewerExecutionTarget {
  backend: ReviewerBackend;
  requestedModel?: string;
  launchModel?: string;
}

export interface CodexReviewerCommand {
  command: string;
  args: string[];
  prompt: string;
}

function normalizeCodexReasoningEffort(level?: string): CodexReasoningEffortLevel | undefined {
  const normalized = level?.trim().toLowerCase();
  switch (normalized) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

export interface CodexReviewerRunResult {
  sessionId: string;
  output: string;
  model?: string;
}

const DEFAULT_TIMEOUT_MS =
  parseInt(process.env.OPENCLAW_HARNESS_REVIEW_TIMEOUT_MS ?? "", 10) || 2 * 60 * 1000;

/**
 * Decide which runtime should execute the reviewer.
 *
 * - Claude-compatible models stay on the existing SessionManager/Claude SDK path.
 * - GPT/Codex models must go through the Codex CLI path instead of the Claude SDK.
 */
export function resolveReviewerExecutionTarget(
  reviewModel?: string,
  fallbackModel?: string,
): ReviewerExecutionTarget {
  const requestedModel = resolveModelAlias(reviewModel ?? fallbackModel);
  if (!requestedModel) {
    return {
      backend: "claude-session",
      requestedModel: fallbackModel,
      launchModel: fallbackModel,
    };
  }

  if (isCodexCapableModel(requestedModel)) {
    return {
      backend: "codex-cli",
      requestedModel,
      launchModel: normalizeCodexModel(requestedModel),
    };
  }

  return {
    backend: "claude-session",
    requestedModel,
    launchModel: requestedModel,
  };
}

export function isCodexCapableModel(model?: string): boolean {
  if (!model) return false;

  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;

  if (normalized.startsWith("openai-codex/") || normalized.startsWith("openai/")) {
    return true;
  }

  return /^(gpt-|o1\b|o3\b|o4\b|codex\b)/i.test(normalized);
}

export function normalizeCodexModel(model?: string): string | undefined {
  if (!model) return undefined;

  const trimmed = model.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("openai-codex/") || trimmed.startsWith("openai/")) {
    const [, providerModel] = trimmed.split(/\/(.+)/, 2);
    return providerModel?.trim() || undefined;
  }

  return trimmed;
}

export function buildCodexReviewerCommand(options: {
  workdir: string;
  outputFile: string;
  model?: string;
  prompt: string;
  reasoningEffort?: string;
  resumeSessionId?: string;
}): CodexReviewerCommand {
  const isResume = !!options.resumeSessionId;

  // First review: `codex exec - --skip-git-repo-check ...`
  // Re-review:    `codex exec resume --skip-git-repo-check <id> - ...`
  // Note: --skip-git-repo-check must come BEFORE SESSION_ID in resume mode
  const args = isResume
    ? ["exec", "resume", "--skip-git-repo-check", options.resumeSessionId!, "-"]
    : ["exec", "-", "--skip-git-repo-check"];

  args.push(
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    options.outputFile,
    "-C",
    options.workdir,
  );

  if (options.model) {
    args.push("-m", options.model);
  }

  const reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort);
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }

  // For resumed sessions, only send the new review prompt (system prompt
  // is already in the conversation history). For fresh sessions, prepend
  // the system prompt.
  const prompt = isResume
    ? options.prompt
    : [REVIEWER_SYSTEM_PROMPT, "", options.prompt].join("\n");

  return {
    command: "codex",
    args,
    prompt,
  };
}

export async function runReviewerWithCodexCli(options: {
  workdir: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  resumeSessionId?: string;
}): Promise<CodexReviewerRunResult> {
  const sessionId = options.resumeSessionId ?? `codex-review-${nanoid(8)}`;
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-harness-review-"));
  const outputFile = join(tempDir, "last-message.txt");
  const normalizedModel = normalizeCodexModel(options.model);
  const command = buildCodexReviewerCommand({
    workdir: options.workdir,
    outputFile,
    model: normalizedModel,
    prompt: options.prompt,
    reasoningEffort: options.reasoningEffort,
    resumeSessionId: options.resumeSessionId,
  });

  try {
    const { output, codexSessionId } = await runCommand(command, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.workdir, outputFile);
    return {
      sessionId: codexSessionId ?? sessionId,
      output,
      model: normalizedModel,
    };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function runCommand(
  command: CodexReviewerCommand,
  timeoutMs: number,
  workdir: string,
  outputFile: string,
): Promise<{ output: string; codexSessionId?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let hardKillTimer: NodeJS.Timeout | null = null;

    const finish = (err?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);

      if (err) {
        reject(err);
        return;
      }

      // Extract codex session ID from stderr (format: "session id: <UUID>")
      const sessionMatch = stderr.match(/session id:\s*([0-9a-f-]{36})/i);
      resolve({ output: output ?? "", codexSessionId: sessionMatch?.[1] });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort hard kill
        }
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("close", (code, signal) => {
      const finalOutput = readCodexOutput(outputFile, stdout);

      if (code === 0) {
        finish(undefined, finalOutput);
        return;
      }

      if (timedOut && finalOutput) {
        console.warn(`[harness] Reviewer Codex CLI exceeded timeout (${timeoutMs}ms) but produced final output; salvaging result.`);
        finish(undefined, finalOutput);
        return;
      }

      const details = [
        timedOut
          ? `Reviewer Codex CLI timed out after ${timeoutMs}ms${signal ? ` (signal ${signal})` : ""}.`
          : `Reviewer Codex CLI exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}.`,
        stderr.trim(),
        stdout.trim(),
      ].filter(Boolean).join("\n\n");

      finish(new Error(details || "Reviewer Codex CLI failed."), finalOutput);
    });

    child.stdin.end(command.prompt);
  });
}

function readCodexOutput(outputFile: string, stdout: string): string {
  if (existsSync(outputFile)) {
    const saved = readFileSync(outputFile, "utf8").trim();
    if (saved) return saved;
  }

  return stdout.trim();
}
