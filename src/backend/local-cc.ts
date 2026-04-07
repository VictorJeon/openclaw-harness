import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, relative, resolve } from "path";
import type { ClaudeEffortLevel, HarnessPlan, TaskSpec, WorkerResult } from "../types";
import type { WorkerBackendHandler, WorkerExecutionContext, WorkerExecutionResult } from "./types";

const LOCAL_CC_COMMAND = "claude";
const LOCAL_CC_STATE_VERSION = 1;
const LOCAL_CC_ROUND_TIMEOUT_MS =
  parseInt(process.env.LOCAL_CC_ROUND_TIMEOUT_MS ?? "", 10) || 5 * 60 * 1000;

export const LOCAL_CC_STATE_ROOT = join(tmpdir(), "openclaw-harness-local-cc");

type LocalCcJobStatus = "idle" | "running" | "waiting" | "done" | "error";
type LocalCcRoundKind = "execute" | "continue";
type LocalCcRoundStatus = "completed" | "failed";

interface LocalCcRoundState {
  round: number;
  kind: LocalCcRoundKind;
  status: LocalCcRoundStatus;
  promptFile: string;
  stdoutFile: string;
  stderrFile: string;
  feedbackFile?: string;
  feedbackHash?: string;
  summary: string;
  workerResult?: WorkerResult;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface LocalCcJobState {
  version: number;
  jobId: string;
  workdir: string;
  taskId: string;
  planId: string;
  model: string;
  status: LocalCcJobStatus;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  lastError?: string;
  rounds: LocalCcRoundState[];
}

export interface LocalCcCommandInput {
  cwd: string;
  prompt: string;
  model: string;
  effort?: ClaudeEffortLevel;
  timeoutMs: number;
}

export interface LocalCcCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export type LocalCcCommandExecutor = (
  input: LocalCcCommandInput,
) => Promise<LocalCcCommandResult>;

let localCcCommandExecutor: LocalCcCommandExecutor = defaultLocalCcCommandExecutor;

export const localCcBackend: WorkerBackendHandler = {
  name: "local-cc",
  available() {
    return true;
  },
  describe() {
    return "Opt-in local Claude Code CLI worker with one-shot rounds and jobId-backed state reuse.";
  },

  async executeWorker(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    return withLocalCcErrorBoundary(context, async () => {
      const state = loadOrCreateLocalCcState(context);
      const reusableRound = findReusableExecuteRound(state);
      if (reusableRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          state.status === "done" ? "done" : "waiting",
          reusableRound.summary,
          reusableRound.workerResult,
        );
      }

      const prompt = buildInitialLocalCcPrompt(context.task, context.plan, context.workdir, context.jobId);
      return await runLocalCcRound(context, state, "execute", prompt);
    });
  },

  async continueWorker(
    context: WorkerExecutionContext,
    feedback: string,
  ): Promise<WorkerExecutionResult> {
    return withLocalCcErrorBoundary(context, async () => {
      const state = loadOrCreateLocalCcState(context);
      const latestCompletedRound = findLatestCompletedRound(state);
      if (!latestCompletedRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          "error",
          "",
          null,
          `local-cc job ${context.jobId} has no completed round to continue. Run executeWorker first.`,
        );
      }

      const reusableRound = findReusableContinueRound(state, feedback);
      if (reusableRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          state.status === "done" ? "done" : "waiting",
          reusableRound.summary,
          reusableRound.workerResult,
        );
      }

      if (state.status === "done") {
        return buildLocalCcExecutionResult(
          context.jobId,
          "done",
          latestCompletedRound.summary,
          latestCompletedRound.workerResult,
        );
      }

      const prompt = buildContinueLocalCcPrompt(
        context.task,
        context.plan,
        context.workdir,
        context.jobId,
        latestCompletedRound.workerResult,
        feedback,
      );

      return await runLocalCcRound(context, state, "continue", prompt, feedback);
    });
  },

  async finalizeWorker(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    return withLocalCcErrorBoundary(context, async () => {
      const state = loadOrCreateLocalCcState(context);
      const latestCompletedRound = findLatestCompletedRound(state);
      if (!latestCompletedRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          "error",
          "",
          null,
          `local-cc job ${context.jobId} has no completed output to finalize.`,
        );
      }

      state.status = "done";
      state.finalizedAt = new Date().toISOString();
      state.updatedAt = state.finalizedAt;
      delete state.lastError;
      persistLocalCcState(state);

      return buildLocalCcExecutionResult(
        context.jobId,
        "done",
        latestCompletedRound.summary,
        latestCompletedRound.workerResult,
      );
    });
  },
};

export function getLocalCcStateDir(jobId: string): string {
  return join(LOCAL_CC_STATE_ROOT, jobId);
}

export function readLocalCcJobState(jobId: string): LocalCcJobState | null {
  const statePath = join(getLocalCcStateDir(jobId), "state.json");
  try {
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, "utf8")) as LocalCcJobState;
  } catch {
    return null;
  }
}

export function __setLocalCcCommandExecutorForTests(executor: LocalCcCommandExecutor): void {
  localCcCommandExecutor = executor;
}

export function __resetLocalCcCommandExecutorForTests(): void {
  localCcCommandExecutor = defaultLocalCcCommandExecutor;
}

async function withLocalCcErrorBoundary(
  context: WorkerExecutionContext,
  fn: () => Promise<WorkerExecutionResult>,
): Promise<WorkerExecutionResult> {
  try {
    return await fn();
  } catch (error: any) {
    const message = error?.message ?? String(error);
    try {
      const state = readLocalCcJobState(context.jobId);
      if (state) {
        state.status = "error";
        state.updatedAt = new Date().toISOString();
        state.lastError = message;
        persistLocalCcState(state);
      }
    } catch {
      // best-effort state recording
    }

    return buildLocalCcExecutionResult(context.jobId, "error", "", null, message);
  }
}

function loadOrCreateLocalCcState(context: WorkerExecutionContext): LocalCcJobState {
  const stateDir = getLocalCcStateDir(context.jobId);
  mkdirSync(stateDir, { recursive: true });

  const existing = readLocalCcJobState(context.jobId);
  if (existing) {
    validateLocalCcState(existing, context);
    return existing;
  }

  const now = new Date().toISOString();
  const state: LocalCcJobState = {
    version: LOCAL_CC_STATE_VERSION,
    jobId: context.jobId,
    workdir: resolve(context.workdir),
    taskId: context.task.id,
    planId: context.plan.id,
    model: normalizeLocalCcModel(context.workerModel),
    status: "idle",
    createdAt: now,
    updatedAt: now,
    rounds: [],
  };
  persistLocalCcState(state);
  return state;
}

function validateLocalCcState(
  state: LocalCcJobState,
  context: WorkerExecutionContext,
): void {
  const expectedWorkdir = resolve(context.workdir);
  if (state.taskId !== context.task.id) {
    throw new Error(
      `local-cc state collision for jobId ${context.jobId}: task mismatch (${state.taskId} != ${context.task.id}).`,
    );
  }
  if (state.planId !== context.plan.id) {
    throw new Error(
      `local-cc state collision for jobId ${context.jobId}: plan mismatch (${state.planId} != ${context.plan.id}).`,
    );
  }
  if (state.workdir !== expectedWorkdir) {
    const oldWorkdir = state.workdir;
    const oldWorkdirExists = existsSync(oldWorkdir);
    console.error(
      `[local-cc] workdir migrated for jobId ${context.jobId}: ${oldWorkdir} -> ${expectedWorkdir}`
      + ` (old workdir ${oldWorkdirExists ? "still exists" : "vanished"})`,
    );
    state.workdir = expectedWorkdir;
    state.updatedAt = new Date().toISOString();
    persistLocalCcState(state);
  }
}

function persistLocalCcState(state: LocalCcJobState): void {
  const stateDir = getLocalCcStateDir(state.jobId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  writeFileSync(join(stateDir, "status"), `${state.status}\n`, "utf8");
  if (state.lastError) {
    writeFileSync(join(stateDir, "error.txt"), `${state.lastError}\n`, "utf8");
  } else {
    rmSync(join(stateDir, "error.txt"), { force: true });
  }
}

function findLatestCompletedRound(state: LocalCcJobState): LocalCcRoundState | null {
  for (let index = state.rounds.length - 1; index >= 0; index--) {
    const round = state.rounds[index];
    if (round.status === "completed" && round.workerResult) {
      return round;
    }
  }
  return null;
}

function findReusableExecuteRound(state: LocalCcJobState): LocalCcRoundState | null {
  return findLatestCompletedRound(state);
}

function findReusableContinueRound(
  state: LocalCcJobState,
  feedback: string,
): LocalCcRoundState | null {
  const feedbackHash = hashLocalCcFeedback(feedback);
  for (let index = state.rounds.length - 1; index >= 0; index--) {
    const round = state.rounds[index];
    if (
      round.kind === "continue"
      && round.status === "completed"
      && round.feedbackHash === feedbackHash
      && round.workerResult
    ) {
      return round;
    }
  }
  return null;
}

async function runLocalCcRound(
  context: WorkerExecutionContext,
  state: LocalCcJobState,
  kind: LocalCcRoundKind,
  prompt: string,
  feedback?: string,
): Promise<WorkerExecutionResult> {
  const nextRound = state.rounds.length + 1;
  const roundPrefix = `round-${String(nextRound).padStart(4, "0")}`;
  const stateDir = getLocalCcStateDir(context.jobId);
  const promptFile = `${roundPrefix}.prompt.txt`;
  const stdoutFile = `${roundPrefix}.stdout.txt`;
  const stderrFile = `${roundPrefix}.stderr.txt`;
  const feedbackFile = feedback ? `${roundPrefix}.feedback.txt` : undefined;
  const startedAt = new Date().toISOString();
  const model = normalizeLocalCcModel(context.workerModel);

  writeFileSync(join(stateDir, promptFile), `${prompt}\n`, "utf8");
  if (feedbackFile) {
    writeFileSync(join(stateDir, feedbackFile), `${feedback ?? ""}\n`, "utf8");
  }

  state.model = model;
  state.status = "running";
  state.updatedAt = startedAt;
  delete state.lastError;
  persistLocalCcState(state);

  // Write a timestamped status line so observers can detect stuck rounds.
  writeFileSync(
    join(stateDir, "status"),
    `running round ${nextRound} since ${startedAt}\n`,
    "utf8",
  );

  const roundTimeoutMs = LOCAL_CC_ROUND_TIMEOUT_MS;
  const commandResult = await localCcCommandExecutor({
    cwd: resolve(context.workdir),
    prompt,
    model,
    effort: context.workerEffort,
    timeoutMs: roundTimeoutMs,
  });

  const stdout = normalizeLocalCcOutput(commandResult.stdout);
  const stderr = normalizeLocalCcOutput(commandResult.stderr);
  const completedAt = new Date().toISOString();
  writeFileSync(join(stateDir, stdoutFile), stdout, "utf8");
  writeFileSync(join(stateDir, stderrFile), stderr, "utf8");

  const output = stdout || stderr;
  if (commandResult.exitCode !== 0 || commandResult.error) {
    const elapsedMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const elapsedSec = Math.round(elapsedMs / 1000);
    const isStuckTimeout = elapsedMs >= roundTimeoutMs * 0.95;
    const error = formatLocalCcCommandFailure(commandResult, stderr, stdout);
    const errorDetail = isStuckTimeout
      ? `local-cc round ${nextRound} for job ${context.jobId} stuck: killed after ${elapsedSec}s (timeout ${Math.round(roundTimeoutMs / 1000)}s). Check ${stateDir} for logs.`
      : undefined;
    state.rounds.push({
      round: nextRound,
      kind,
      status: "failed",
      promptFile,
      stdoutFile,
      stderrFile,
      feedbackFile,
      feedbackHash: feedback ? hashLocalCcFeedback(feedback) : undefined,
      summary: summarizeLocalCcOutput(output),
      error: errorDetail ?? error,
      startedAt,
      completedAt,
    });
    state.status = "error";
    state.updatedAt = completedAt;
    state.lastError = errorDetail ?? error;
    persistLocalCcState(state);
    return buildLocalCcExecutionResult(context.jobId, "error", output, null, errorDetail ?? error, errorDetail);
  }

  if (!output) {
    const error = `local-cc worker ${context.jobId} produced no output.`;
    state.rounds.push({
      round: nextRound,
      kind,
      status: "failed",
      promptFile,
      stdoutFile,
      stderrFile,
      feedbackFile,
      feedbackHash: feedback ? hashLocalCcFeedback(feedback) : undefined,
      summary: "",
      error,
      startedAt,
      completedAt,
    });
    state.status = "error";
    state.updatedAt = completedAt;
    state.lastError = error;
    persistLocalCcState(state);
    return buildLocalCcExecutionResult(context.jobId, "error", "", null, error);
  }

  const workerResult = buildLocalCcWorkerResult(
    context.task.id,
    output,
    context.jobId,
    context.workdir,
  );
  state.rounds.push({
    round: nextRound,
    kind,
    status: "completed",
    promptFile,
    stdoutFile,
    stderrFile,
    feedbackFile,
    feedbackHash: feedback ? hashLocalCcFeedback(feedback) : undefined,
    summary: workerResult.summary,
    workerResult,
    startedAt,
    completedAt,
  });
  state.status = "waiting";
  state.updatedAt = completedAt;
  delete state.lastError;
  persistLocalCcState(state);

  return buildLocalCcExecutionResult(
    context.jobId,
    "waiting",
    output,
    workerResult,
  );
}

function buildLocalCcExecutionResult(
  jobId: string,
  status: string,
  output: string,
  workerResult: WorkerResult | null,
  error?: string,
  errorDetail?: string,
): WorkerExecutionResult {
  return {
    jobId,
    stateDir: getLocalCcStateDir(jobId),
    output,
    status,
    workerResult,
    error,
    errorDetail,
  };
}

function buildInitialLocalCcPrompt(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  jobId: string,
): string {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria
    : ["Complete the requested change without expanding scope."];

  return [
    "You are Claude Code executing one task inside the OpenClaw harness.",
    `Job ID: ${jobId}`,
    `Work only in this repository/worktree: ${resolve(workdir)}`,
    "",
    `## Task`,
    task.title,
    "",
    `Original request: ${plan.originalRequest}`,
    "",
    `## Scope`,
    task.scope,
    "",
    `## Acceptance Criteria`,
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `## Rules`,
    `- Make the requested code changes directly in the workdir.`,
    `- Stay tightly within the stated scope.`,
    `- Do not depend on any remote worker, SDK session, or Hetzner flow.`,
    `- Run focused validation when practical.`,
    "",
    ...buildLocalCcResponseFormat(),
  ].join("\n");
}

function buildContinueLocalCcPrompt(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  jobId: string,
  previousWorkerResult: WorkerResult,
  feedback: string,
): string {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria
    : ["Complete the requested change without expanding scope."];

  return [
    "You are Claude Code continuing an OpenClaw harness task in a fresh one-shot run.",
    `Job ID: ${jobId}`,
    `Work only in this repository/worktree: ${resolve(workdir)}`,
    "",
    `## Task`,
    task.title,
    "",
    `Original request: ${plan.originalRequest}`,
    "",
    `## Scope`,
    task.scope,
    "",
    `## Acceptance Criteria`,
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `## Previous Worker Summary`,
    clipLocalCcText(previousWorkerResult.summary, 120, 12000),
    "",
    `## Reviewer Feedback To Address`,
    clipLocalCcText(feedback, 120, 12000),
    "",
    `## Rules`,
    `- Fix only the issues raised in the reviewer feedback.`,
    `- Preserve already-correct work unless a fix requires touching it.`,
    `- Run focused validation when practical.`,
    "",
    ...buildLocalCcResponseFormat(),
  ].join("\n");
}

function buildLocalCcResponseFormat(): string[] {
  return [
    "## Final Response Format",
    "Return plain text using these exact section headers:",
    "Summary:",
    "Files changed:",
    "Tests run:",
    "Warnings:",
  ];
}

function buildLocalCcWorkerResult(
  taskId: string,
  output: string,
  sessionId: string,
  workdir: string,
): WorkerResult {
  return {
    taskId,
    status: "completed",
    summary: summarizeLocalCcOutput(output),
    filesChanged: extractLocalCcFilePaths(output, workdir),
    testsRun: extractLocalCcTestCount(output),
    warnings: extractLocalCcWarnings(output),
    sessionId,
  };
}

function summarizeLocalCcOutput(output: string): string {
  const normalized = normalizeLocalCcOutput(output);
  if (!normalized) return "";

  const tailLines = normalized.split("\n").slice(-80).join("\n");
  if (tailLines.length <= 8000) {
    return tailLines;
  }
  return tailLines.slice(-8000);
}

function extractLocalCcFilePaths(output: string, workdir: string): string[] {
  const paths: string[] = [];
  const root = resolve(workdir);
  const regex = /(?:^|[\s`'"(\[])(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+|\/[\w./-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),:;\]])/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(output)) !== null) {
    let candidate = match[1].trim();
    if (!candidate) continue;

    if (candidate.startsWith("/")) {
      if (!candidate.startsWith(root + "/")) continue;
      candidate = relative(root, candidate);
    }

    candidate = candidate.replace(/^\.\//, "");
    if (!candidate || candidate === ".." || candidate.startsWith("../")) continue;
    paths.push(candidate);
  }

  return [...new Set(paths)];
}

function extractLocalCcTestCount(output: string): number {
  const match = output.match(/(\d+)\s*(?:tests?|specs?)\s*(?:passed|ran|ok)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function extractLocalCcWarnings(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\b(?:warning|warn)\b/i.test(line))
    .slice(0, 10);
}

function normalizeLocalCcOutput(output: string): string {
  return String(output ?? "").replace(/\r/g, "").trim();
}

function clipLocalCcText(text: string, maxLines: number, maxChars: number): string {
  const normalized = normalizeLocalCcOutput(text);
  if (!normalized) return "";

  const tailLines = normalized.split("\n").slice(-maxLines).join("\n");
  if (tailLines.length <= maxChars) {
    return tailLines;
  }
  return tailLines.slice(-maxChars);
}

function hashLocalCcFeedback(feedback: string): string {
  return createHash("sha256").update(feedback.trim()).digest("hex");
}

function normalizeLocalCcModel(workerModel: string): string {
  const raw = (workerModel ?? "").trim();
  const normalized = raw.toLowerCase();
  if (!raw) return "sonnet";

  if (raw.includes("/")) {
    const [provider, model] = raw.split("/", 2);
    if (provider === "anthropic" && model) {
      return model;
    }
    return normalized.includes("opus") ? "opus" : "sonnet";
  }

  if (normalized === "claude" || normalized === "sonnet") {
    return "sonnet";
  }
  if (normalized === "opus") {
    return "opus";
  }
  if (normalized.includes("claude-opus") || normalized.includes("opus")) {
    return raw;
  }
  if (normalized.includes("claude-sonnet") || normalized.includes("sonnet")) {
    return raw;
  }

  return normalized.includes("opus") ? "opus" : "sonnet";
}

function buildLocalCcArgs(model: string, prompt: string, effort?: ClaudeEffortLevel): string[] {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    model,
  ];

  if (effort) {
    args.push("--effort", effort);
  }

  args.push(prompt);
  return args;
}

export function __buildLocalCcArgsForTests(model: string, prompt: string, effort?: ClaudeEffortLevel): string[] {
  return buildLocalCcArgs(model, prompt, effort);
}

function buildLocalCcChildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const home = (env.HOME ?? "").trim() || homedir();
  const claudeCredentialsPath = join(home, ".claude", ".credentials.json");

  if (existsSync(claudeCredentialsPath)) {
    delete env.ANTHROPIC_API_KEY;
  }

  return env;
}

export function __buildLocalCcChildEnvForTests(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildLocalCcChildEnv(baseEnv);
}

async function defaultLocalCcCommandExecutor(
  input: LocalCcCommandInput,
): Promise<LocalCcCommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(LOCAL_CC_COMMAND, buildLocalCcArgs(input.model, input.prompt, input.effort), {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildLocalCcChildEnv(process.env),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let hardKillTimer: NodeJS.Timeout | null = null;

    const finish = (result: LocalCcCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolvePromise(result);
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
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const message = error.code === "ENOENT"
        ? `Claude Code CLI not found on PATH. Install the local \`${LOCAL_CC_COMMAND}\` CLI or switch workerBackend to "remote-realtime".`
        : error.message;
      finish({
        exitCode: -1,
        stdout,
        stderr,
        error: message,
      });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          exitCode: code ?? -1,
          stdout,
          stderr,
          error: `Claude Code CLI timed out after ${input.timeoutMs}ms${signal ? ` (${signal})` : ""}.`,
        });
        return;
      }

      finish({
        exitCode: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function formatLocalCcCommandFailure(
  result: LocalCcCommandResult,
  stderr: string,
  stdout: string,
): string {
  if (result.error) {
    return [
      result.error,
      stderr,
      stdout,
    ].filter(Boolean).join("\n\n");
  }

  return [
    `Claude Code CLI exited with code ${result.exitCode}.`,
    stderr,
    stdout,
  ].filter(Boolean).join("\n\n");
}
