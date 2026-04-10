import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, join, relative, resolve } from "path";
import { Type } from "@sinclair/typebox";
import { getSessionManager, pluginConfig, getPluginRuntime } from "../shared";
import { resolveWorkerBackend } from "../backend/factory";
import type { WorkerExecutionContext } from "../backend/types";
import { classifyRequest } from "../router";
import { buildPlan, buildModelPlan, searchMemory } from "../planner";
import {
  findRecoverableCheckpoint,
  getPendingTasks,
  initCheckpoint,
  loadCheckpoint,
  recordSession,
  saveCheckpoint,
  updateTaskStatus,
} from "../checkpoint";
import { initReviewLoop, processReviewResult, formatEscalation, buildReviewRequest } from "../review-loop";
import { runReviewerConsensus } from "../reviewer-consensus";
import { runMetaReview } from "../meta-reviewer";
import { parseReviewOutput, REVIEWER_SYSTEM_PROMPT } from "../reviewer";
import { resolveModelAlias } from "../model-resolution";
import { resolveReviewerExecutionTarget, runReviewerWithCodexCli } from "../reviewer-runner";
import { prepareExecutionWorkspace, materializeExecutionWorkspace } from "../workspace-isolation";
import type {
  OpenClawPluginToolContext,
  HarnessPlan,
  ReviewResult,
  WorkerResult,
  CheckpointData,
  TaskSpec,
} from "../types";

/**
 * harness_execute: The main entry point for the harness.
 *
 * Full orchestration:
 *   1. Router classifies request → tier 0/1/2
 *   2. Approval gate (mode-dependent)
 *   3. Planner decomposes into tasks
 *   4. Dispatcher routes worker to realtime Claude worker (claude-realtime.sh)
 *      for all coding work (tier 1+). Tier 0 stays direct execution.
 *   5. Waits for Worker completion → extracts WorkerResult
 *   6. Spawns Reviewer session (Codex CLI) → parses ReviewResult
 *   7. Review loop: fix via realtime worker → rereview (max N cycles)
 *   8. Checkpoint updated at each step
 *   9. Returns structured result or escalation
 *
 * Worker runtime model (2026-04-04 unification):
 *   - Tier 0: caller agent direct execution
 *   - Tier 1+: claude-realtime.sh / shared realtime runtime on Hetzner
 *   - Reviewer: Codex CLI (unchanged)
 *   - The Claude SDK session worker path (subagent.run / sessionManager.spawn)
 *     is no longer used for primary coding tasks.
 *   - workerModel config is preserved for legacy compatibility but ignored
 *     for realtime-worker execution (realtime model is resolved separately).
 */
export function makeHarnessExecuteTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "harness_execute",
    description:
      "Primary path for coding tasks. Execute a coding task through the Plan-Work-Review harness. Automatically classifies complexity, decomposes tasks, dispatches workers, and runs cross-model review. Returns a structured result with gaps detected.",
    parameters: Type.Object({
      request: Type.String({
        description: "The coding task to execute (natural language)",
      }),
      workdir: Type.Optional(
        Type.String({ description: "Working directory for the task" }),
      ),
      tier_override: Type.Optional(
        Type.Union(
          [Type.Literal(0), Type.Literal(1), Type.Literal(2)],
          { description: "Override automatic tier classification" },
        ),
      ),
      max_budget_usd: Type.Optional(
        Type.Number({ description: "Maximum budget in USD (default from config)" }),
      ),
      reviewOnly: Type.Optional(
        Type.Boolean({ description: "Skip planner/worker and review existing local changes only" }),
      ),
    }),
    async execute(_id: string, params: any) {
      const activeSessionManager = getSessionManager();
      if (!activeSessionManager) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Error: SessionManager not initialized. The harness service must be running.",
          }],
        };
      }

      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      const mode = "autonomous" as const;
      const maxBudgetUsd = params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5;

      // Review-only lane: skip planner/worker, review existing local changes
      if (params.reviewOnly) {
        return await executeReviewOnly(params.request, workdir, ctx);
      }

      const autoResumeCheckpoint = findRecoverableCheckpoint(params.request, workdir);

      // Step 1: Route — classify request complexity
      const route = await classifyRequest(params.request);
      const routerTier = params.tier_override ?? route.tier;

      console.log(`[harness] Route: tier=${routerTier}, confidence=${route.confidence}, reason=${route.reason}`);

      // Analysis mode: read-only requests skip worker + reviewer entirely
      if (routerTier >= 1 && isAnalysisOnlyRequest(params.request)) {
        return {
          content: [{
            type: "text",
            text: [
              `## Harness: Analysis Mode (read-only)`,
              ``,
              `Request detected as analysis/review — no file modifications.`,
              `Execute this analysis directly without spawning a worker.`,
              ``,
              `**Request:** ${params.request}`,
              `**Workdir:** ${workdir}`,
            ].join("\n"),
          }],
        };
      }

      // Step 2: Autonomous-only execution (no approval gate)
      const existingCheckpoint: CheckpointData | null = autoResumeCheckpoint;

      if (existingCheckpoint) {
        // If checkpoint is still "running", an async background run is already in flight.
        // Do NOT restart it — report the existing plan instead. This prevents double-execution
        // when the caller retries the same request before the first run finishes.
        if (existingCheckpoint.status === "running") {
          console.log(`[harness] Existing run still active: ${existingCheckpoint.runId} — skipping duplicate execution`);
          return {
            content: [{
              type: "text",
              text: [
                `## Harness: Already Running`,
                ``,
                `**Plan:** ${existingCheckpoint.runId}`,
                `**Status:** running`,
                `**Tasks:** ${existingCheckpoint.tasks.length}`,
                ``,
                `A background run for this request is already in progress. Results will be pushed when complete.`,
                `Monitor: \`cat /tmp/harness/${existingCheckpoint.runId}/checkpoint.json\``,
              ].join("\n"),
            }],
          };
        }

        console.log(`[harness] Auto-resuming recoverable checkpoint: ${existingCheckpoint.runId}`);
        const plan = existingCheckpoint.plan;
        const runState = buildExecutionRunState(existingCheckpoint);
        if (runState.mode === "resumed" && existingCheckpoint.status !== "complete") {
          existingCheckpoint.status = "running";
          existingCheckpoint.lastUpdated = new Date().toISOString();
          saveCheckpoint(existingCheckpoint, workdir);
          console.log(
            `[harness] Resuming checkpoint ${existingCheckpoint.runId}: skippedCompleted=${runState.skippedCompletedTaskIds.length}, remaining=${runState.resumedTaskIds.length}`,
          );
        }
        const preparedWorkspace = plan.tier > 0
          ? prepareExecutionWorkspace(workdir, plan.id)
          : { originalWorkdir: workdir, executionWorkdir: workdir, isolated: false };
        const taskResults = await executePlan(plan, preparedWorkspace.executionWorkdir, maxBudgetUsd, ctx, existingCheckpoint);
        const materialized = plan.tier > 0 ? materializeExecutionWorkspace(preparedWorkspace) : null;

        return {
          content: [{
            type: "text",
            text: formatFinalResult(plan, route, taskResults, mode, existingCheckpoint, runState, materialized),
          }],
        };
      }

      // Tier 0 (non-risky): direct execution by the OpenClaw agent
      if (routerTier === 0) {
        return {
          content: [{
            type: "text",
            text: [
              `## Harness: Tier 0 — Direct Execution`,
              ``,
              `Simple config/doc/patch task. Execute directly without spawning a worker.`,
              ``,
              `**Request:** ${params.request}`,
              `**Workdir:** ${workdir}`,
              `**Route reason:** ${route.reason}`,
            ].join("\n"),
          }],
        };
      }

      const memoryContext = await loadPlanningMemory(workdir);

      // Step 3: Plan — then apply effectiveTier = min(router, planner)
      const plan = await createExecutionPlan(params.request, routerTier as 1 | 2, memoryContext, workdir);
      const effectiveTier = Math.min(routerTier, plan.tier) as 0 | 1 | 2;
      if (effectiveTier !== plan.tier) {
        console.log(`[harness] effectiveTier override: planner=${plan.tier} → effective=${effectiveTier} (router=${routerTier})`);
        (plan as any).tier = effectiveTier;
      }
      console.log(`[harness] Plan: id=${plan.id}, tasks=${plan.tasks.length}, mode=${plan.mode}, effectiveTier=${effectiveTier}`);

      const preparedWorkspace = prepareExecutionWorkspace(workdir, plan.id);
      const checkpoint = initCheckpoint(plan, workdir, preparedWorkspace.executionWorkdir);

      // ── Fire-and-forget async execution ──
      // Return immediately with plan_id so the orchestrator is unblocked.
      // The actual Plan → Work → Review loop runs in background.
      // On completion, push the final result via notification (Telegram).
      const notificationChannel = ctx.messageChannel;

      void (async () => {
        try {
          const taskResults = await executePlan(plan, preparedWorkspace.executionWorkdir, maxBudgetUsd, ctx, checkpoint);
          const materialized = materializeExecutionWorkspace(preparedWorkspace);
          const finalText = formatFinalResult(plan, route, taskResults, mode, checkpoint, freshExecutionRunState(), materialized);

          // Push final result to the originating channel
          await sendHarnessNotification(notificationChannel, ctx, `완료 — plan ${plan.id}\n\n${finalText}`);
          console.log(`[harness] Background run complete: plan=${plan.id}, tasks=${taskResults.length}`);
        } catch (err: any) {
          const errorMsg = `하네스 실패 — plan ${plan.id}: ${err?.message ?? String(err)}`;
          await sendHarnessNotification(notificationChannel, ctx, errorMsg);
          console.error(`[harness] Background run failed: plan=${plan.id}`, err);
        }
      })();

      // Immediate return — orchestrator is unblocked in <3s
      return {
        content: [{
          type: "text",
          text: [
            `## Harness: Started (async)`,
            ``,
            `**Plan:** ${plan.id}`,
            `**Tasks:** ${plan.tasks.length} (${plan.mode})`,
            `**Tier:** ${effectiveTier} | **Route:** ${route.confidence}`,
            `**Workdir:** ${workdir}`,
            ``,
            `Worker is running in background. Results will be pushed to your channel when complete.`,
            `Monitor: \`cat /tmp/harness/${plan.id}/checkpoint.json\``,
          ].join("\n"),
        }],
      };
    },
  };
}

async function loadPlanningMemory(workdir: string): Promise<string> {
  try {
    return await searchMemory(basename(workdir) || "project");
  } catch {
    return "";
  }
}

async function createExecutionPlan(
  request: string,
  tier: 1 | 2,
  memoryContext: string,
  workdir: string,
): Promise<HarnessPlan> {
  return await buildModelPlan(request, memoryContext, workdir, undefined, tier);
}

// --- Review-only lane ---

/**
 * Execute a review-only run: skip planner/worker, synthesize a WorkerResult
 * from local git changes, and run the existing reviewer path.
 */
async function executeReviewOnly(
  request: string,
  workdir: string,
  ctx: OpenClawPluginToolContext,
) {
  const { changedFiles, diffStat } = await collectLocalChanges(workdir);

  if (changedFiles.length === 0) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Error: No local changes found in ${workdir}. Nothing to review.`,
      }],
    };
  }

  const taskId = "review-1";
  const planId = `review-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;

  const task: TaskSpec = {
    id: taskId,
    title: request.slice(0, 120),
    scope: workdir,
    acceptanceCriteria: [request],
    agent: "codex",
  };

  const syntheticWorkerResult: WorkerResult = {
    taskId,
    status: "completed",
    summary: diffStat || `${changedFiles.length} file(s) changed locally`,
    filesChanged: changedFiles,
    testsRun: 0,
    warnings: [],
  };

  const plan: HarnessPlan = {
    id: planId,
    originalRequest: request,
    tasks: [task],
    mode: "solo",
    estimatedComplexity: "low",
    tier: 0,
  };

  // Resolve reviewer backend (same logic as normal path)
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const reviewerReasoningEffort = pluginConfig.reviewerReasoningEffort;
  const reviewerTarget = resolveReviewerExecutionTarget(reviewModel, pluginConfig.defaultModel);

  // Run consensus review (no fix loop — reviewer is read-only)
  const reviewLoop = initReviewLoop(taskId);
  let reviewResult: ReviewResult | null = null;
  let reviewerRetryCount = 0;

  while (true) {
    const consensusResult = await runReviewerConsensus({
      task,
      workerResult: syntheticWorkerResult,
      originalRequest: request,
      reviewLoopState: reviewLoop,
      workdir,
    });

    console.log(`[harness] Review-only consensus done: mode=${consensusResult.mode}, result=${consensusResult.consensus.result}, retry=${reviewerRetryCount}`);

    reviewResult = consensusResult.consensus;
    if (!reviewResult.retryReviewer) break;

    reviewerRetryCount++;
    if (reviewerRetryCount >= 3) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Error: Reviewer output could not be parsed after 3 attempts in review-only mode.`,
        }],
      };
    }

    console.warn(`[harness] Review-only reviewer output malformed: retry=${reviewerRetryCount}/3`);
  }

  if (!reviewResult) {
    throw new Error("Reviewer result missing after retry loop");
  }

  const action = processReviewResult(reviewLoop, reviewResult);
  // No fix loop — report result as-is
  return {
    content: [{
      type: "text",
      text: formatReviewOnlyResult(plan, syntheticWorkerResult, reviewResult, reviewLoop, action.action),
    }],
  };
}

/**
 * Collect changed files and diff stat from the workdir via git.
 * Includes both staged and unstaged changes.
 */
export async function collectLocalChanges(workdir: string): Promise<{
  changedFiles: string[];
  diffStat: string;
}> {
  // Check both staged and unstaged changes
  const [diffNames, diffStat] = await Promise.all([
    execFileCapture("git", ["diff", "--name-only", "HEAD"], workdir, 15_000)
      .catch(() => execFileCapture("git", ["diff", "--name-only"], workdir, 15_000))
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" })),
    execFileCapture("git", ["diff", "--stat", "HEAD"], workdir, 15_000)
      .catch(() => execFileCapture("git", ["diff", "--stat"], workdir, 15_000))
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" })),
  ]);

  // Also pick up untracked files
  const untracked = await execFileCapture(
    "git", ["ls-files", "--others", "--exclude-standard"], workdir, 15_000,
  ).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));

  const changedFiles = [
    ...diffNames.stdout.trim().split("\n").filter(Boolean),
    ...untracked.stdout.trim().split("\n").filter(Boolean),
  ];
  const uniqueFiles = [...new Set(changedFiles)];

  return {
    changedFiles: uniqueFiles,
    diffStat: diffStat.stdout.trim(),
  };
}

function formatReviewOnlyResult(
  plan: HarnessPlan,
  workerResult: WorkerResult,
  reviewResult: ReviewResult,
  reviewLoop: ReturnType<typeof initReviewLoop>,
  action: string,
): string {
  const passed = reviewResult.result === "pass";
  const lines = [
    `## Harness: Review Only — ${passed ? "Pass" : "Gaps Found"}`,
    ``,
    `**Mode:** review-only | **Plan:** ${plan.id}`,
    `**Changed files:** ${workerResult.filesChanged.length}`,
    `**Review loops:** ${reviewLoop.history.length}`,
    `**Result:** ${reviewResult.result}${reviewResult.gaps.length > 0 ? ` (${reviewResult.gaps.length} gap${reviewResult.gaps.length > 1 ? "s" : ""})` : ""}`,
    ``,
    `### Changed Files`,
    ...workerResult.filesChanged.map((f) => `- ${f}`),
    ``,
    `### Review Result`,
  ];

  if (passed) {
    lines.push(`No gaps detected. All acceptance criteria appear to be met.`);
  } else {
    for (const gap of reviewResult.gaps) {
      lines.push(`- **${gap.type}:** ${gap.evidence}`);
      if (gap.fixHint) lines.push(`  Fix hint: ${gap.fixHint}`);
    }
  }

  return lines.join("\n");
}

// --- Orchestration ---

interface TaskExecutionResult {
  taskId: string;
  workerSessionId: string;
  workerResult: WorkerResult | null;
  reviewPassed: boolean;
  reviewLoops: number;
  escalated: boolean;
  escalationReason?: string;
  error?: string;
}

interface ExecutionRunState {
  mode: "fresh" | "resumed";
  skippedCompletedTaskIds: string[];
  resumedTaskIds: string[];
}

const REALTIME_STATE_ROOT = join("/tmp", "claude-realtime");
const REALTIME_SCRIPT_PATH = join(
  homedir(),
  ".openclaw",
  "workspace-nova",
  "scripts",
  "claude-realtime.sh",
);
const GIT_SYNC_SCRIPT_PATH = join(
  homedir(),
  ".openclaw",
  "workspace-nova",
  "scripts",
  "git-sync.sh",
);
const REALTIME_REMOTE_HOST = process.env.OPENCLAW_REALTIME_REMOTE_HOST || "hetzner-build";
const REALTIME_EMBEDDED_PLAN_REVIEW_ENV = "OPENCLAW_HARNESS_EMBEDDED_PLAN_REVIEW";
const REALTIME_LAUNCH_TIMEOUT_MS = 90_000;
const REALTIME_PULL_TIMEOUT_MS = 180_000;
const REALTIME_POLL_INTERVAL_MS = 5_000;
const REALTIME_MAX_WAIT_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;

export interface RealtimeLaunchResult {
  jobId: string;
  stateDir: string;
  output: string;
}

export interface RealtimeExecutionResult extends RealtimeLaunchResult {
  status: string;
  workerResult: WorkerResult | null;
  error?: string;
}

type PlanReviewVerdict = "PROCEED" | "REVISE" | "DONE" | "ABORT";
type EmbeddedRealtimeReviewKind = "plan";
type RealtimeCheckpointReviewMode = "embedded-plan";

interface EmbeddedPlanReviewResult {
  kind: EmbeddedRealtimeReviewKind;
  verdict: PlanReviewVerdict;
  body: string;
  feedback: string;
  rawText: string;
  reviewerSessionId: string;
  round: number;
}

function requireHarnessSessionManager() {
  const activeSessionManager = getSessionManager();
  if (!activeSessionManager) {
    throw new Error("SessionManager not initialized. The harness service must be running.");
  }

  return activeSessionManager;
}

async function executePlan(
  plan: HarnessPlan,
  workdir: string,
  maxBudgetUsd: number,
  ctx: OpenClawPluginToolContext,
  checkpoint: CheckpointData,
): Promise<TaskExecutionResult[]> {
  const resultsByTaskId = new Map<string, TaskExecutionResult>();
  const tasksToRun: TaskSpec[] = [];

  for (const task of plan.tasks) {
    const completedResult = buildCompletedCheckpointResult(checkpoint, task.id);
    if (completedResult) {
      resultsByTaskId.set(task.id, completedResult);
      continue;
    }
    tasksToRun.push(task);
  }

  if (tasksToRun.length === 0) {
    return plan.tasks
      .map((task) => resultsByTaskId.get(task.id))
      .filter((result): result is TaskExecutionResult => result != null);
  }

  const budgetPerTask = maxBudgetUsd / tasksToRun.length;

  if (plan.mode === "parallel" && tasksToRun.length > 1) {
    // Parallel with concurrency limit based on runtime available slots
    // Reserve half for review/fix phases, recompute before each batch
    let i = 0;
    while (i < tasksToRun.length) {
      // Wait for at least one slot before spawning
      const hasSlot = await requireHarnessSessionManager().waitForSlot();
      if (!hasSlot) {
        // Timeout — push remaining as errors
        for (let j = i; j < tasksToRun.length; j++) {
          resultsByTaskId.set(tasksToRun[j].id, {
            taskId: tasksToRun[j].id,
            workerSessionId: "",
            workerResult: null,
            reviewPassed: false,
            reviewLoops: 0,
            escalated: true,
            error: "No session slots available (timeout)",
          });
        }
        break;
      }

      // Compute batch size from current availability (reserve half for review/fix)
      const batchSize = Math.max(1, Math.floor(requireHarnessSessionManager().availableSlots() / 2));
      const batch = tasksToRun.slice(i, i + batchSize);
      const batchPromises = batch.map((task) =>
        executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint).catch((err: any) => ({
          taskId: task.id,
          workerSessionId: "",
          workerResult: null,
          reviewPassed: false,
          reviewLoops: 0,
          escalated: true,
          error: err?.message ?? String(err),
        })),
      );
      i += batch.length;

      // Wait for batch to complete before next batch
      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        resultsByTaskId.set(result.taskId, result);
      }

      if (i < tasksToRun.length) {
        await Promise.allSettled(batchPromises);
      }
    }
  } else {
    // Sequential (or solo): execute tasks one by one
    for (const task of tasksToRun) {
      const result = await executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint);
      resultsByTaskId.set(task.id, result);

      // If a sequential task didn't pass, stop the chain
      if (plan.mode === "sequential" && !result.reviewPassed) {
        break;
      }
    }
  }

  return plan.tasks
    .map((task) => resultsByTaskId.get(task.id))
    .filter((result): result is TaskExecutionResult => result != null);
}

async function executeTask(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  budgetUsd: number,
  ctx: OpenClawPluginToolContext,
  checkpoint: CheckpointData,
): Promise<TaskExecutionResult> {
  const activeSessionManager = requireHarnessSessionManager();
  // realtimeModel is the preferred config key for tier 1+ Claude realtime
  // workers. workerModel remains as a legacy fallback for compatibility.
  const workerModel = pluginConfig.realtimeModel ?? pluginConfig.workerModel ?? "claude";
  const workerEffort = pluginConfig.workerEffort;
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const reviewerReasoningEffort = pluginConfig.reviewerReasoningEffort;
  // Tier 1+ tasks resolve their worker backend through the factory.
  // Tier 0 still falls through to sessionManager.spawn.
  const useBackendDispatch = plan.tier >= 1;
  const backend = useBackendDispatch ? resolveWorkerBackend(pluginConfig) : null;
  const isRealtimeBackend = backend?.name === "remote-realtime";

  // Fail fast if the resolved backend reports itself unavailable.
  if (backend && !backend.available()) {
    updateTaskStatus(checkpoint, task.id, "failed", workdir);
    return {
      taskId: task.id,
      workerSessionId: "",
      workerResult: null,
      reviewPassed: false,
      reviewLoops: 0,
      escalated: true,
      error: `Worker backend "${backend.name}" is not available: ${backend.describe()}`,
    };
  }

  const reviewerTarget = resolveReviewerExecutionTarget(
    reviewModel,
    pluginConfig.defaultModel,
  );

  // Budget: split across phases with a remaining counter
  // Initial worker gets 50%. Remaining 50% covers:
  //   1 initial review + maxLoops * (fix + rereview)
  // When maxLoops=0: only 1 review phase (no fix cycles)
  const maxLoops = Math.max(0, pluginConfig.maxReviewLoops);
  const workerBudget = budgetUsd * 0.5;
  let remainingBudget = budgetUsd * 0.5;
  const totalPhases = maxLoops === 0 ? 1 : 1 + 2 * maxLoops;
  const perPhaseBudget = remainingBudget / totalPhases;
  let workerSessionId = "";
  const totalReviewLoops = (outerLoops: number): number => (
    outerLoops + (isRealtimeBackend ? getRealtimeImplementationReviewLoops(workerSessionId) : 0)
  );

  try {
    resetCheckpointTaskForRetry(checkpoint, task.id);

    // --- Worker phase ---
    updateTaskStatus(checkpoint, task.id, "in-progress", workdir);

    const workerPrompt = buildWorkerPrompt(task, plan);
    let workerResult: WorkerResult | null = null;

    if (useBackendDispatch && backend) {
      // Tier 1+ coding work dispatches through the resolved backend.
      // remote-realtime recovers completed output here; local-cc reuses its
      // own jobId-backed state internally inside the backend implementation.
      const existingJobId = checkpoint.sessions[task.id]?.worker ?? "";
      const recoveredResult = isRealtimeBackend && existingJobId
        ? recoverCompletedRealtimeWorkerResult(task.id, existingJobId)
        : null;

      if (recoveredResult) {
        workerSessionId = existingJobId;
        workerResult = recoveredResult;
        console.log(
          `[harness] Recovered completed worker from checkpoint: task=${task.id}, jobId=${workerSessionId}, backend=${backend.name}`,
        );
      } else {
        workerSessionId = existingJobId || buildRealtimeJobId(plan.id, task.id);
        // Persist the job id before launch/wait so resume can recover if the tool turn dies
        recordSession(checkpoint, task.id, "worker", workerSessionId, workdir);

        const backendCtx: WorkerExecutionContext = {
          task, plan, workdir, ctx, workerModel, workerEffort, jobId: workerSessionId,
        };
        const backendResult = await backend.executeWorker(backendCtx);

        if (!isRealtimeReviewReadyStatus(backendResult.status) || !backendResult.workerResult) {
          updateTaskStatus(checkpoint, task.id, "failed", workdir, {
            workerResult: backendResult.workerResult ?? undefined,
          });
          const backendError = backendResult.errorDetail
            ?? backendResult.error
            ?? `Worker job ${workerSessionId} ended with status=${backendResult.status}`;
          return {
            taskId: task.id,
            workerSessionId,
            workerResult: backendResult.workerResult,
            reviewPassed: false,
            reviewLoops: 0,
            escalated: true,
            error: isRealtimeBackend
              ? formatRealtimeFailureForCaller(ctx, workdir, backendError)
              : backendError,
          };
        }

        workerResult = backendResult.workerResult;
      }
    } else {
      // === Fallback: sessionManager.spawn (CC PTY) — only reachable for tier 0 edge cases ===
      console.warn(`[harness] Fallback to sessionManager.spawn (tier 0 / no realtime)`);
      const workerSession = activeSessionManager.spawn({
        prompt: workerPrompt,
        name: `harness-${plan.id}-${task.id}`,
        workdir,
        model: workerModel,
        maxBudgetUsd: workerBudget,
        permissionMode: pluginConfig.permissionMode ?? "bypassPermissions",
        originChannel: ctx.messageChannel,
        originAgentId: ctx.agentId,
        multiTurn: false,
      });
      workerSessionId = workerSession.id;
      workerResult = await waitForCompletion(workerSession.id, task.id);
    }

    recordSession(checkpoint, task.id, "worker", workerSessionId, workdir);
    console.log(
      `[harness] Worker done: task=${task.id}, session=${workerSessionId}, model=${workerModel}, backend=${backend?.name ?? "session-fallback"}`,
    );

    if (!workerResult) {
      updateTaskStatus(checkpoint, task.id, "failed", workdir);
      return {
        taskId: task.id,
        workerSessionId,
        workerResult: null,
        reviewPassed: false,
        reviewLoops: 0,
        escalated: true,
        error: "Worker session did not produce a result",
      };
    }

    updateTaskStatus(checkpoint, task.id, "in-review", workdir, { workerResult });

    // --- Review phase: cross-model review loop ---
    const reviewLoop = initReviewLoop(task.id);
    let currentWorkerResult = workerResult;
    // Track the Codex reviewer session ID for same-session continuity
    // across re-reviews within this task. The first review creates the
    // session; subsequent reviews resume it so the reviewer remembers
    // previous gaps and context.
    let reviewerCodexSessionId: string | undefined;

    while (!reviewLoop.passed && !reviewLoop.escalated) {
      let reviewResult: ReviewResult | null = null;
      let reviewerRetryCount = 0;

      while (true) {
        const reviewBudget = Math.min(perPhaseBudget, remainingBudget);
        remainingBudget -= reviewBudget;

        // Reviewer consensus: run primary + secondary in parallel
        const consensusResult = await runReviewerConsensus({
          task,
          workerResult: currentWorkerResult,
          originalRequest: plan.originalRequest,
          reviewLoopState: reviewLoop,
          workdir,
          resumeSessionId: reviewerCodexSessionId,
        });

        // Capture primary Codex session ID for subsequent resumes
        if (!reviewerCodexSessionId && consensusResult.primarySessionId) {
          reviewerCodexSessionId = consensusResult.primarySessionId;
        }
        recordSession(checkpoint, task.id, "reviewer", consensusResult.primarySessionId ?? `consensus-${consensusResult.mode}`, workdir);

        console.log(
          `[harness] Reviewer consensus done: task=${task.id}, loop=${reviewLoop.history.length + 1}, mode=${consensusResult.mode}, result=${consensusResult.consensus.result}`,
        );

        reviewResult = consensusResult.consensus;
        if (!reviewResult.retryReviewer) {
          break;
        }

        reviewerRetryCount++;
        if (reviewerRetryCount >= 3) {
          updateTaskStatus(checkpoint, task.id, "failed", workdir, {
            reviewPassed: false,
            reviewLoop: totalReviewLoops(reviewLoop.history.length),
          });
          return {
            taskId: task.id,
            workerSessionId,
            workerResult: currentWorkerResult,
            reviewPassed: false,
            reviewLoops: totalReviewLoops(reviewLoop.history.length),
            escalated: true,
            error: "Reviewer output could not be parsed after 3 attempts",
          };
        }

        console.warn(
          `[harness] Reviewer output malformed: task=${task.id}, retry=${reviewerRetryCount}/3`,
        );
      }

      if (!reviewResult) {
        throw new Error("Reviewer result missing after retry loop");
      }

      const action = processReviewResult(reviewLoop, reviewResult);
      console.log(`[harness] Review result: task=${task.id}, action=${action.action}, gaps=${reviewResult.gaps.length}`);

      if (action.action === "pass") {
        if (useBackendDispatch && backend) {
          const backendCtx: WorkerExecutionContext = {
            task, plan, workdir, ctx, workerModel, workerEffort, jobId: workerSessionId,
          };
          const finalizeResult = await backend.finalizeWorker(backendCtx);
          if (finalizeResult.workerResult) {
            currentWorkerResult = finalizeResult.workerResult;
          }
          if (finalizeResult.status !== "done") {
            updateTaskStatus(checkpoint, task.id, "failed", workdir, {
              reviewPassed: false,
              reviewLoop: totalReviewLoops(reviewLoop.history.length),
              reviewResult,
              workerResult: currentWorkerResult,
            });
            const finalizeError = finalizeResult.error ?? `Worker finalization ended with status=${finalizeResult.status}`;
            return {
              taskId: task.id,
              workerSessionId,
              workerResult: currentWorkerResult,
              reviewPassed: false,
              reviewLoops: totalReviewLoops(reviewLoop.history.length),
              escalated: true,
              error: isRealtimeBackend
                ? formatRealtimeFailureForCaller(ctx, workdir, finalizeError)
                : finalizeError,
            };
          }
        }

        updateTaskStatus(checkpoint, task.id, "completed", workdir, {
          reviewPassed: true,
          reviewLoop: totalReviewLoops(reviewLoop.history.length),
          reviewResult,
          workerResult: currentWorkerResult,
        });
        return {
          taskId: task.id,
          workerSessionId,
          workerResult: currentWorkerResult,
          reviewPassed: true,
          reviewLoops: totalReviewLoops(reviewLoop.history.length),
          escalated: false,
        };
      }

      if (action.action === "escalate") {
        // Meta-reviewer mediation before escalating to human.
        // Gives one more chance to resolve disagreements between worker and reviewer.
        console.log(`[harness] Fix loop exhausted for task=${task.id}, running meta-reviewer...`);
        const metaResult = await runMetaReview({ task, plan, reviewLoopState: reviewLoop, workdir });
        console.log(`[harness] Meta-reviewer verdict: ${metaResult.verdict} — ${metaResult.reasoning}`);

        if (metaResult.verdict === "approve") {
          // Meta-reviewer says gaps are acceptable — force pass
          updateTaskStatus(checkpoint, task.id, "completed", workdir, {
            reviewPassed: true,
            reviewLoop: totalReviewLoops(reviewLoop.history.length),
            reviewResult,
            workerResult: currentWorkerResult,
          });
          return {
            taskId: task.id,
            workerSessionId,
            workerResult: currentWorkerResult,
            reviewPassed: true,
            reviewLoops: totalReviewLoops(reviewLoop.history.length),
            escalated: false,
          };
        }

        if (metaResult.verdict === "revise" && metaResult.consolidatedFixPrompt) {
          // Meta-reviewer provides one bonus fix attempt
          console.log(`[harness] Meta-reviewer grants bonus fix round for task=${task.id}`);
          if (useBackendDispatch && backend) {
            const backendCtx: WorkerExecutionContext = {
              task, plan, workdir, ctx, workerModel, workerEffort, jobId: workerSessionId,
            };
            const bonusResult = await backend.continueWorker(backendCtx, metaResult.consolidatedFixPrompt);
            if (bonusResult.workerResult) {
              currentWorkerResult = bonusResult.workerResult;
              updateTaskStatus(checkpoint, task.id, "in-review", workdir, {
                reviewPassed: false,
                reviewLoop: totalReviewLoops(reviewLoop.history.length),
                reviewResult,
                workerResult: currentWorkerResult,
              });
              // Reset escalation flag and continue the review loop for one more round
              reviewLoop.escalated = false;
              continue;
            }
          }
        }

        // Meta-reviewer says reject (or revise failed) — escalate to human
        updateTaskStatus(checkpoint, task.id, "failed", workdir, {
          reviewPassed: false,
          reviewLoop: totalReviewLoops(reviewLoop.history.length),
          reviewResult,
        });
        return {
          taskId: task.id,
          workerSessionId,
          workerResult: currentWorkerResult,
          reviewPassed: false,
          reviewLoops: totalReviewLoops(reviewLoop.history.length),
          escalated: true,
          escalationReason: formatEscalation(plan, reviewLoop, task),
        };
      }

      // action === "fix": feed gap feedback back into the worker via backend dispatch
      if (action.action === "fix") {
        if (useBackendDispatch && backend) {
          const backendCtx: WorkerExecutionContext = {
            task, plan, workdir, ctx, workerModel, workerEffort, jobId: workerSessionId,
          };
          const followUpResult = await backend.continueWorker(backendCtx, action.fixPrompt);

          if (!isRealtimeReviewReadyStatus(followUpResult.status) || !followUpResult.workerResult) {
            updateTaskStatus(checkpoint, task.id, "failed", workdir, {
              reviewPassed: false,
              reviewLoop: totalReviewLoops(reviewLoop.history.length),
              reviewResult,
              workerResult: followUpResult.workerResult ?? currentWorkerResult,
            });
            const followUpError = followUpResult.errorDetail
              ?? followUpResult.error
              ?? `Worker follow-up ended with status=${followUpResult.status}`;
            return {
              taskId: task.id,
              workerSessionId,
              workerResult: followUpResult.workerResult ?? currentWorkerResult,
              reviewPassed: false,
              reviewLoops: totalReviewLoops(reviewLoop.history.length),
              escalated: true,
              escalationReason: formatEscalation(plan, reviewLoop, task),
              error: isRealtimeBackend
                ? formatRealtimeFailureForCaller(ctx, workdir, followUpError)
                : followUpError,
            };
          }

          currentWorkerResult = followUpResult.workerResult;
          updateTaskStatus(checkpoint, task.id, "in-review", workdir, {
            reviewPassed: false,
            reviewLoop: totalReviewLoops(reviewLoop.history.length),
            reviewResult,
            workerResult: currentWorkerResult,
          });
          continue;
        }

        // Fallback fix path (tier 0 edge case only — should not normally be reached)
        console.warn(`[harness] Fix fallback via sessionManager.spawn: task=${task.id}, loop=${reviewLoop.currentLoop}`);
        const fixBudget = Math.min(perPhaseBudget, remainingBudget);
        remainingBudget -= fixBudget;
        const fixSession = activeSessionManager.spawn({
          prompt: action.fixPrompt,
          name: `harness-${plan.id}-${task.id}-fix-${reviewLoop.currentLoop}`,
          workdir,
          model: workerModel,
          maxBudgetUsd: fixBudget,
          permissionMode: pluginConfig.permissionMode ?? "bypassPermissions",
          originChannel: ctx.messageChannel,
          originAgentId: ctx.agentId,
          multiTurn: false,
        });
        const fixResult = await waitForCompletion(fixSession.id, task.id);
        if (fixResult) {
          currentWorkerResult = fixResult;
        }
        // Continue loop → next review iteration
      }
    }

    // Should not reach here, but safety fallback
    return {
      taskId: task.id,
      workerSessionId,
      workerResult: currentWorkerResult,
      reviewPassed: false,
      reviewLoops: totalReviewLoops(reviewLoop.history.length),
      escalated: true,
      error: "Review loop exited unexpectedly",
    };
  } catch (err: any) {
    updateTaskStatus(checkpoint, task.id, "failed", workdir);
    const detailedError = `${err.message}\n${err.stack ?? ""}`;
    return {
      taskId: task.id,
      workerSessionId,
      workerResult: null,
      reviewPassed: false,
      reviewLoops: 0,
      escalated: true,
      error: isRealtimeBackend
        ? formatRealtimeFailureForCaller(ctx, workdir, detailedError)
        : detailedError,
    };
  } finally {
    // Do not eagerly delete harness subagent sessions here.
    // OpenClaw can still be flushing transcript/tool-result state shortly after
    // waitForRun() resolves; deleting immediately risks racing persistence and
    // produces missing-transcript / transcript-repair failures that make
    // harness runs look like instant worker crashes.
  }
}

// --- Session completion helpers ---

interface SessionCompletion {
  status: "completed" | "failed" | "killed" | "timeout";
  output: string;
  error?: string;
}

export async function executeRealtimeTask(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  ctx: OpenClawPluginToolContext,
  workerModel: string,
  workerEffort: import("../types").ClaudeEffortLevel | undefined,
  jobId: string,
): Promise<RealtimeExecutionResult> {
  const resolvedWorkdir = resolve(workdir);
  assertRealtimeProjectContext(resolvedWorkdir);
  const spec = buildRealtimeSpec(task, plan, resolvedWorkdir);
  const realtimeModel = resolveRealtimeModel(workerModel);
  const notifyAgent = resolveRealtimeNotifyAgent(ctx, resolvedWorkdir);

  console.log(
    `[harness] Realtime worker invoking claude-realtime.sh: script=${REALTIME_SCRIPT_PATH}, jobId=${jobId}, workdir=${resolvedWorkdir}, model=${realtimeModel}, effort=${workerEffort ?? "default"}, notifyAgent=${notifyAgent}`,
  );

  const launch = await launchRealtimeJob(spec, resolvedWorkdir, jobId, realtimeModel, workerEffort, notifyAgent);
  return await waitForRealtimeCheckpoint(task, plan, resolvedWorkdir, ctx, launch.jobId, launch.stateDir, "round-complete");
}

export async function continueRealtimeTask(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  ctx: OpenClawPluginToolContext,
  jobId: string,
  feedback: string,
): Promise<RealtimeExecutionResult> {
  const resolvedWorkdir = resolve(workdir);
  const stateDir = join(REALTIME_STATE_ROOT, jobId);
  await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, feedback);
  console.log(`[harness] Tier 2 follow-up feedback sent: jobId=${jobId}`);
  return await waitForRealtimeCheckpoint(task, plan, resolvedWorkdir, ctx, jobId, stateDir, "round-complete");
}

export async function finalizeRealtimeTask(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  ctx: OpenClawPluginToolContext,
  jobId: string,
): Promise<RealtimeExecutionResult> {
  const resolvedWorkdir = resolve(workdir);
  const stateDir = join(REALTIME_STATE_ROOT, jobId);
  const currentStatus = readRealtimeStatus(stateDir);
  if (currentStatus !== "done") {
    await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, "DONE");
    console.log(`[harness] Tier 2 final DONE sent: jobId=${jobId}, previousStatus=${currentStatus ?? "missing"}`);
  }
  return await waitForRealtimeCheckpoint(task, plan, resolvedWorkdir, ctx, jobId, stateDir, "terminal");
}

async function waitForRealtimeCheckpoint(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  ctx: OpenClawPluginToolContext,
  jobId: string,
  stateDir: string,
  goal: "round-complete" | "terminal",
): Promise<RealtimeExecutionResult> {
  const terminal = await waitForRealtimeTerminalState(
    stateDir,
    jobId,
    task,
    plan,
    ctx,
    workdir,
    goal,
  );

  if (terminal.status === "waiting" || terminal.status === "done") {
    await syncRealtimeWorktreeFromRemote(workdir);
  }

  const workerResult = buildRealtimeWorkerResult(task.id, terminal.status, terminal.summary, terminal.sessionId ?? jobId);
  return {
    jobId,
    stateDir,
    output: terminal.summary,
    status: terminal.status,
    workerResult,
    error: isRealtimeReviewReadyStatus(terminal.status) || terminal.status === "done"
      ? undefined
      : formatRealtimeFailure(jobId, stateDir, terminal.status, terminal.summary),
  };
}

async function launchRealtimeJob(
  spec: string,
  workdir: string,
  jobId: string,
  model: "opus" | "sonnet",
  effort: import("../types").ClaudeEffortLevel | undefined,
  notifyAgent: string,
): Promise<RealtimeLaunchResult> {
  if (!existsSync(REALTIME_SCRIPT_PATH)) {
    throw new Error(`claude-realtime.sh not found at ${REALTIME_SCRIPT_PATH}`);
  }

  const args = [
    REALTIME_SCRIPT_PATH,
    spec,
    workdir,
    "--remote",
    "--bg",
    "--job-id",
    jobId,
    "--model",
    model,
    ...(effort ? ["--effort", effort] : []),
    "--notify-agent",
    notifyAgent,
  ];
  const launch = await execFileCapture(
    "bash",
    args,
    workdir,
    REALTIME_LAUNCH_TIMEOUT_MS,
    { [REALTIME_EMBEDDED_PLAN_REVIEW_ENV]: "1" },
  );
  const combinedOutput = [launch.stdout, launch.stderr].filter(Boolean).join("\n").trim();
  const stateDir = parseRealtimeStateDir(combinedOutput, jobId);

  if (launch.exitCode !== 0) {
    throw new Error([
      `claude-realtime.sh launch failed (exit ${launch.exitCode})`,
      combinedOutput,
    ].filter(Boolean).join("\n"));
  }

  console.log(
    `[harness] Realtime worker launched: jobId=${jobId}, stateDir=${stateDir}, output=${combinedOutput || "(empty)"}`,
  );

  return {
    jobId,
    stateDir,
    output: combinedOutput,
  };
}

async function execFileCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = REALTIME_LAUNCH_TIMEOUT_MS,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, ...(envOverrides ?? {}) },
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ exitCode: 0, stdout, stderr });
          return;
        }

        const err = error as NodeJS.ErrnoException & { code?: number | string };
        const errorMessage = err.message?.trim();
        const mergedStderr = errorMessage && !stderr.includes(errorMessage)
          ? [stderr, errorMessage].filter(Boolean).join("\n")
          : stderr;

        resolvePromise({
          exitCode: typeof err.code === "number" ? err.code : -1,
          stdout,
          stderr: mergedStderr,
        });
      },
    );
  });
}

async function syncRealtimeWorktreeFromRemote(workdir: string): Promise<void> {
  if (!existsSync(GIT_SYNC_SCRIPT_PATH)) {
    throw new Error(`git-sync.sh not found at ${GIT_SYNC_SCRIPT_PATH}`);
  }

  const result = await execFileCapture(
    "bash",
    [GIT_SYNC_SCRIPT_PATH, "pull", workdir, "--remote-host", REALTIME_REMOTE_HOST],
    workdir,
    REALTIME_PULL_TIMEOUT_MS,
    { [REALTIME_EMBEDDED_PLAN_REVIEW_ENV]: "1" },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.exitCode !== 0) {
    throw new Error(`git-sync pull failed for ${workdir}${output ? `\n${output}` : ""}`);
  }

  console.log(
    `[harness] Tier 2 sync pull complete: workdir=${workdir}, remote=${REALTIME_REMOTE_HOST}${output ? `, output=${output}` : ""}`,
  );
}

function sanitizeCodexPromptOutput(stdout: string): string {
  return stdout
    .replace(/\r/g, "")
    .replace(/^\s*\[done\]\s*end_turn\s*$/gim, "")
    .trim();
}

function realtimeCheckpointReviewModeForStatus(
  status: string | null | undefined,
  stateDir: string,
  _goal: "round-complete" | "terminal",
): RealtimeCheckpointReviewMode | null {
  if (status === "plan_waiting") {
    const currentRound = detectLatestRealtimeRound(stateDir);
    if (hasImplementationReviewArtifactForRound(stateDir, currentRound)) {
      return null;
    }
    return "embedded-plan";
  }
  return null;
}

function reviewArtifactPrefix(kind: EmbeddedRealtimeReviewKind | "implementation", round: number): string {
  return kind === "plan"
    ? `plan-review-round-${round}`
    : `implementation-review-round-${round}`;
}

export function __realtimeCheckpointReviewModeForTests(
  status: string | null | undefined,
  stateDir = REALTIME_STATE_ROOT,
  goal: "round-complete" | "terminal" = "round-complete",
): RealtimeCheckpointReviewMode | null {
  return realtimeCheckpointReviewModeForStatus(status, stateDir, goal);
}

async function waitForRealtimeTerminalState(
  stateDir: string,
  jobId: string,
  task: TaskSpec,
  plan: HarnessPlan,
  ctx: OpenClawPluginToolContext,
  workdir: string,
  goal: "round-complete" | "terminal" = "terminal",
): Promise<{ status: string; summary: string; sessionId?: string }> {
  const startedAt = Date.now();
  let lastStatus = readRealtimeStatus(stateDir) ?? "launching";
  const reviewedCheckpoints = new Set<string>();
  let lastHeartbeatAt = startedAt;
  const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
  const HEARTBEAT_INITIAL_MS = 20_000;  // first heartbeat at 20s
  const notifyChannel = ctx.messageChannel;

  while (Date.now() - startedAt < REALTIME_MAX_WAIT_MS) {
    const currentStatus = readRealtimeStatus(stateDir);
    if (currentStatus) {
      lastStatus = currentStatus;
    }

    // Heartbeat: periodic progress push so user knows worker is alive
    const elapsed = Date.now() - startedAt;
    const timeSinceLastHbeat = Date.now() - lastHeartbeatAt;
    const heartbeatDue = (elapsed < HEARTBEAT_INITIAL_MS + 5000)
      ? timeSinceLastHbeat >= HEARTBEAT_INITIAL_MS
      : timeSinceLastHbeat >= HEARTBEAT_INTERVAL_MS;

    if (heartbeatDue) {
      // Touch the checkpoint file so stale cleanup knows this plan is alive
      // (cleanup checks filesystem mtime, not just JSON lastUpdated).
      try {
        const cpPath = join("/tmp", "harness", plan.id, "checkpoint.json");
        if (existsSync(cpPath)) {
          const now = new Date();
          require("fs").utimesSync(cpPath, now, now);
        }
      } catch { /* best-effort */ }

      if (notifyChannel && notifyChannel !== "unknown") {
        const round = detectLatestRealtimeRound(stateDir);
        const elapsedSec = Math.round(elapsed / 1000);
        sendHarnessNotification(notifyChannel, ctx,
          `⏳ ${jobId.slice(-12)} | ${lastStatus} | round ${round} | ${elapsedSec}s`,
        ).catch(() => {});
      }
      lastHeartbeatAt = Date.now();
    }

    const reviewMode = realtimeCheckpointReviewModeForStatus(lastStatus, stateDir, goal);
    if (reviewMode) {
      const currentRound = detectLatestRealtimeRound(stateDir);
      const reviewKey = `${reviewMode}:${currentRound}`;
      if (!reviewedCheckpoints.has(reviewKey)) {
        reviewedCheckpoints.add(reviewKey);
        const artifactPrefix = reviewArtifactPrefix(
          reviewMode === "embedded-plan" ? "plan" : "implementation",
          currentRound,
        );
        try {
          const review = await runEmbeddedRealtimePlanReview({
            stateDir,
            jobId,
            round: currentRound,
            task,
            plan,
            ctx,
            workdir,
            kind: "plan",
          });

          writeFileSync(join(stateDir, `${artifactPrefix}.raw.txt`), review.rawText, "utf8");
          writeFileSync(join(stateDir, `${artifactPrefix}.feedback.txt`), review.feedback, "utf8");
          writeFileSync(
            join(stateDir, `${artifactPrefix}.source.txt`),
            [
              "source=embedded-agent",
              `kind=${review.kind}`,
              `agent=${ctx.agentId ?? ctx.agentAccountId ?? "main"}`,
              `reviewerSessionId=${review.reviewerSessionId}`,
              `verdict=${review.verdict}`,
            ].join("\n") + "\n",
            "utf8",
          );

          await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, review.feedback);
          console.log(
            `[harness] Embedded ${review.kind} review sent: job=${jobId}, round=${currentRound}, verdict=${review.verdict}, reviewer=${review.reviewerSessionId}`,
          );
        } catch (err: any) {
          const detail = `Embedded caller-agent plan review failed for ${jobId} round ${currentRound}: ${err?.message ?? String(err)}`;
          writeFileSync(join(stateDir, `${artifactPrefix}.error.txt`), detail + "\n", "utf8");
          try {
            await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, "ABORT");
          } catch (feedbackErr: any) {
            console.warn(
              `[harness] Failed to send ABORT after embedded plan review error: ${feedbackErr?.message ?? String(feedbackErr)}`,
            );
          }
          return {
            status: "error:plan-review",
            ...buildRealtimeSummary(
              stateDir,
              "error:plan-review",
              detail,
            ),
          };
        }
      }
      await sleep(REALTIME_POLL_INTERVAL_MS);
      continue;
    }

    if (goal === "round-complete" && lastStatus === "waiting") {
      await sleep(REALTIME_POLL_INTERVAL_MS);
      continue;
    }

    if (lastStatus === "plan_violation") {
      const handling = classifyPlanViolationHandling(stateDir, goal);
      if (handling === "waiting") {
        return {
          status: "waiting",
          ...buildRealtimeSummary(
            stateDir,
            "waiting",
            "Recovered round-complete after transient plan_violation with a later successful worker result.",
          ),
        };
      }
      if (handling === "defer") {
        await sleep(REALTIME_POLL_INTERVAL_MS);
        continue;
      }
    }

    if (isRealtimeTerminalStatus(lastStatus)) {
      const recoveredSuccess = goal === "terminal"
        ? recoverSuccessfulRealtimeTerminalState(stateDir, lastStatus)
        : null;
      if (recoveredSuccess) {
        return recoveredSuccess;
      }
      return {
        status: lastStatus,
        ...buildRealtimeSummary(stateDir, lastStatus),
      };
    }

    await sleep(REALTIME_POLL_INTERVAL_MS);
  }

  const recoveredSuccess = goal === "terminal"
    ? recoverSuccessfulRealtimeTerminalState(stateDir, "error:timeout")
    : null;
  if (recoveredSuccess) {
    return recoveredSuccess;
  }

  const timeoutStatus = "error:timeout";
  return {
    status: timeoutStatus,
    ...buildRealtimeSummary(
      stateDir,
      timeoutStatus,
      `Timed out waiting for realtime ${goal}. Last observed status: ${lastStatus}.`,
    ),
  };
}

async function runEmbeddedRealtimePlanReview(params: {
  stateDir: string;
  jobId: string;
  round: number;
  task: TaskSpec;
  plan: HarnessPlan;
  ctx: OpenClawPluginToolContext;
  workdir: string;
  kind: EmbeddedRealtimeReviewKind;
}): Promise<EmbeddedPlanReviewResult> {
  const runtime = getPluginRuntime();
  if (!runtime?.agent?.runEmbeddedPiAgent || !runtime?.config?.loadConfig) {
    throw new Error("plugin runtime.agent.runEmbeddedPiAgent is unavailable");
  }

  const agentId = params.ctx.agentId ?? params.ctx.agentAccountId ?? "main";
  const cfg = await runtime.config.loadConfig();

  let agentDir: string | undefined;
  try {
    agentDir = runtime.agent.resolveAgentDir(cfg, agentId);
  } catch {
    agentDir = undefined;
  }

  let reviewWorkspaceDir = params.ctx.workspaceDir || process.cwd();
  try {
    reviewWorkspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  } catch {
    // fall back to the invoking context workspace
  }

  const latestResult = readLatestRealtimeResult(params.stateDir);
  let retryReason = "";
  const embeddedReviewerTarget = resolveEmbeddedReviewerProviderAndModel(
    pluginConfig.reviewModel,
    pluginConfig.defaultModel,
  );

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-plan-review-"));
    const reviewerSessionId = `harness-plan-review-${params.jobId}-r${params.round}-a${attempt}-${Date.now()}`;
    const reviewerSessionKey = buildHarnessSubagentSessionKey(
      agentId,
      params.jobId,
      `${params.task.id}-${params.kind}-r${params.round}-a${attempt}`,
      "reviewer",
    );
    const sessionFile = join(tempDir, "session.jsonl");

    try {
      const prompt = buildEmbeddedPlanReviewPrompt({
        ...params,
        agentId,
        latestResultText: latestResult?.resultText ?? "",
        retryReason,
        compact: attempt >= 2,
      });

      const resolvedTimeoutMs = runtime.agent.resolveAgentTimeoutMs
        ? runtime.agent.resolveAgentTimeoutMs(cfg)
        : 240000;
      const timeoutMs = typeof resolvedTimeoutMs === "number" && resolvedTimeoutMs > 0
        ? Math.min(resolvedTimeoutMs, 240000)
        : 240000;

      const result = await runtime.agent.runEmbeddedPiAgent({
        sessionId: reviewerSessionId,
        sessionKey: reviewerSessionKey,
        agentId,
        sessionFile,
        workspaceDir: reviewWorkspaceDir,
        agentDir,
        config: cfg,
        prompt,
        provider: embeddedReviewerTarget.provider,
        model: embeddedReviewerTarget.model,
        timeoutMs,
        runId: randomUUID(),
        trigger: "manual",
        disableTools: true,
        bootstrapContextMode: "lightweight",
      });

      const rawText = collectEmbeddedPayloadText(result?.payloads);
      writeFileSync(
        join(params.stateDir, `${reviewArtifactPrefix("plan", params.round)}.attempt-${attempt}.txt`),
        rawText || "",
        "utf8",
      );

      const parsed = parseEmbeddedPlanReviewResponse(rawText);

      const feedback = parsed.verdict === "DONE"
        ? "DONE"
        : parsed.verdict === "ABORT"
          ? "ABORT"
          : parsed.body;

      if ((parsed.verdict === "PROCEED" || parsed.verdict === "REVISE") && feedback.trim().length < 200) {
        retryReason = `Your previous ${parsed.verdict} response was too short (${feedback.trim().length} chars). Keep the same verdict only if still correct, but rewrite the body to at least 220 characters with concrete next-step instructions for Claude Code.`;
        continue;
      }

      return {
        kind: params.kind,
        verdict: parsed.verdict,
        body: parsed.body,
        feedback,
        rawText,
        reviewerSessionId,
        round: params.round,
      };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      lastError = message;
      if (!isTransientEmbeddedReviewError(message) || attempt >= 4) {
        throw err;
      }
      const backoffMs = Math.min(5000 * attempt, 15000);
      console.warn(
        `[harness] Embedded ${params.kind} review transient failure: job=${params.jobId}, round=${params.round}, attempt=${attempt}/4, retryInMs=${backoffMs}, error=${message}`,
      );
      await sleep(backoffMs);
      continue;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  throw new Error(lastError ?? `embedded ${params.kind} review did not return a valid verdict/body for ${params.jobId} round ${params.round}`);
}

function buildEmbeddedPlanReviewPrompt(params: {
  stateDir: string;
  jobId: string;
  round: number;
  task: TaskSpec;
  plan: HarnessPlan;
  ctx: OpenClawPluginToolContext;
  workdir: string;
  agentId: string;
  latestResultText: string;
  kind: EmbeddedRealtimeReviewKind;
  retryReason?: string;
  compact?: boolean;
}): string {
  const compact = params.compact === true;
  const latestResult = params.latestResultText.trim()
    ? tailText(params.latestResultText, compact ? 18 : 40, compact ? 1400 : 3200)
    : "(latest Claude result unavailable)";
  const acceptanceCriteria = params.task.acceptanceCriteria.length > 0
    ? params.task.acceptanceCriteria
      .slice(0, compact ? 6 : 10)
      .map((item) => `- ${tailText(item, 2, compact ? 180 : 280)}`)
      .join("\n")
    : "- Complete the requested change without expanding scope.";
  const originalRequest = tailText(params.plan.originalRequest, compact ? 10 : 20, compact ? 900 : 1800);
  const taskScope = tailText(params.task.scope, compact ? 6 : 12, compact ? 500 : 900);

  const isPlanReview = params.kind === "plan";

  return [
    `You are the OpenClaw agent \`${params.agentId}\` reviewing a Claude Code ${isPlanReview ? "planning" : "implementation"} checkpoint for the coding harness.`,
    `The harness was invoked by this same agent, so the verdict and feedback must come from you directly.`,
    params.retryReason ? `Retry requirement: ${params.retryReason}` : "",
    compact ? "Compact mode: focus only on the current task, not the whole conversation." : "",
    "",
    "Return format (strict):",
    "- First line must be exactly one of: VERDICT: PROCEED | VERDICT: REVISE | VERDICT: DONE | VERDICT: ABORT",
    isPlanReview
      ? "- For plan checkpoints, use PROCEED to approve the plan, REVISE to request a different implementation path, DONE only if the task is already finished, and ABORT if the task must stop."
      : "- For implementation checkpoints, use DONE if the task satisfies the acceptance criteria, REVISE to request concrete follow-up changes, and ABORT only if the task must stop. Do not use PROCEED for implementation checkpoints.",
    "- If the verdict is PROCEED or REVISE, the body must be 220-1200 characters, concrete, and addressed to Claude Code.",
    isPlanReview
      ? "- For PROCEED, restate the approved path, scope, constraints, and validation steps."
      : "- For REVISE, explain exactly what is wrong in the current implementation and what Claude Code must change next.",
    isPlanReview
      ? "- For REVISE, explain exactly what is wrong and what Claude Code must change before implementing."
      : "- For DONE, body is optional; use it only if a short justification materially helps.",
    "- For DONE or ABORT, body is optional.",
    "- No markdown fences. No intro. No notes to Mason. No tool calls.",
    "",
    "Job context:",
    `- jobId: ${params.jobId}`,
    `- round: ${params.round}`,
    `- checkpoint kind: ${params.kind}`,
    `- repo/workdir: ${params.workdir}`,
    `- original request: ${originalRequest}`,
    `- task title: ${params.task.title}`,
    `- task scope: ${taskScope}`,
    "",
    "Acceptance criteria:",
    acceptanceCriteria,
    "",
    "Latest Claude Code checkpoint:",
    latestResult,
  ].filter(Boolean).join("\n");
}

function parseEmbeddedPlanReviewResponse(rawText: string): { verdict: PlanReviewVerdict; body: string } {
  const normalized = rawText.replace(/\r/g, "").trim();
  if (!normalized) {
    throw new Error("embedded plan review returned empty output");
  }

  const verdictStart = normalized.search(/VERDICT:/i);
  const candidate = verdictStart >= 0 ? normalized.slice(verdictStart).trim() : normalized;
  const verdictMatch = candidate.match(/VERDICT:\s*(PROCEED|REVISE|DONE|ABORT)/i);
  if (!verdictMatch) {
    throw new Error(`embedded plan review missing VERDICT. Output head: ${tailText(normalized, 8, 400)}`);
  }

  const verdict = verdictMatch[1].toUpperCase() as PlanReviewVerdict;
  const lines = candidate.split("\n");
  const firstVerdictLineIndex = lines.findIndex((line) => /VERDICT:/i.test(line));
  const firstVerdictLine = firstVerdictLineIndex >= 0 ? lines[firstVerdictLineIndex] : candidate;
  const inlineBody = firstVerdictLine
    .replace(/.*VERDICT:\s*(?:PROCEED|REVISE|DONE|ABORT)\s*/i, "")
    .trim();
  const body = [inlineBody, ...lines.slice(firstVerdictLineIndex + 1)]
    .join("\n")
    .trim();

  return { verdict, body };
}

function isTransientEmbeddedReviewError(message: string): boolean {
  return /(temporarily overloaded|overloaded|rate limit|try again in a moment|timeout|timed out|temporarily unavailable|context overflow|prompt too large)/i.test(message);
}

function collectEmbeddedPayloadText(
  payloads: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean }> | undefined,
): string {
  return (payloads ?? [])
    .map((payload) => payload?.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function writeRealtimeFeedback(remoteHost: string, stateDir: string, feedback: string): Promise<void> {
  const stateDirB64 = Buffer.from(stateDir, "utf8").toString("base64");
  const feedbackB64 = Buffer.from(feedback, "utf8").toString("base64");
  const python = [
    "import base64",
    "from pathlib import Path",
    `state_dir = Path(base64.b64decode(\"${stateDirB64}\").decode(\"utf-8\"))`,
    `feedback = base64.b64decode(\"${feedbackB64}\").decode(\"utf-8\")`,
    "state_dir.mkdir(parents=True, exist_ok=True)",
    "(state_dir / \"feedback\").write_text(feedback, encoding=\"utf-8\")",
    "history = state_dir / \"feedback-history.log\"",
    "fh = history.open(\"a\", encoding=\"utf-8\")",
    "fh.write(feedback.rstrip(\"\\n\") + \"\\n\")",
    "fh.close()",
  ].join("; ");

  const result = await execFileCapture(
    "ssh",
    [remoteHost, `python3 -c '${python}'`],
    process.cwd(),
    30000,
  );

  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`failed to write realtime feedback to ${remoteHost}:${stateDir}${output ? `\n${output}` : ""}`);
  }
}

async function syncRealtimeStateFromRemote(remoteHost: string, stateDir: string): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const result = await execFileCapture(
    "scp",
    ["-q", "-r", `${remoteHost}:${stateDir}/.`, `${stateDir}/`],
    process.cwd(),
    30000,
  );
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`failed to sync realtime state from ${remoteHost}:${stateDir}${output ? `\n${output}` : ""}`);
  }
}

function detectLatestRealtimeRound(stateDir: string): number {
  try {
    if (!existsSync(stateDir)) return 1;
    const resultFiles = readdirSync(stateDir)
      .filter((name) => /^result-\d+\.json$/.test(name))
      .sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    if (resultFiles.length === 0) return 1;
    return Math.max(1, extractRealtimeRound(resultFiles[resultFiles.length - 1]));
  } catch {
    return 1;
  }
}

function readRealtimeStatus(stateDir: string): string | null {
  return readTextFileIfExists(join(stateDir, "status"))?.trim() || null;
}

function isRealtimeTerminalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (
    status === "done"
    || status === "aborted"
    || status === "plan_violation"
    || status === "loop"
    || status === "error"
    || status.startsWith("error:")
  );
}

type LatestRealtimeResult = {
  sessionId?: string;
  resultText?: string;
  numTurns?: number;
  costUsd?: number;
  subtype?: string;
  isError?: boolean;
  round?: number;
  permissionDenials?: string[];
};

type RealtimeReviewDiagnostics = {
  implementationRounds: number;
  implementationVerdicts: string[];
  planReviewRounds: number;
  lastPlanReviewError?: string;
};

function extractArtifactRound(filename: string): number {
  const match = filename.match(/-(\d+)\.[^.]+(?:\.[^.]+)?$/);
  return match ? parseInt(match[1], 10) : 0;
}

function listRealtimeArtifacts(stateDir: string, pattern: RegExp): Array<{ round: number; path: string }> {
  try {
    if (!existsSync(stateDir)) return [];
    return readdirSync(stateDir)
      .filter((name) => pattern.test(name))
      .map((name) => ({ round: extractArtifactRound(name), path: join(stateDir, name) }))
      .sort((a, b) => a.round - b.round);
  } catch {
    return [];
  }
}

function parseReviewVerdictFromSource(path: string): string | null {
  const text = readTextFileIfExists(path);
  if (!text) return null;
  const match = text.match(/^verdict=(.+)$/m);
  return match?.[1]?.trim() || null;
}

function hasImplementationReviewArtifactForRound(stateDir: string, round: number): boolean {
  if (round <= 0) return false;
  return existsSync(join(stateDir, `implementation-review-round-${round}.source.txt`));
}

function collectRealtimeReviewDiagnostics(stateDir: string): RealtimeReviewDiagnostics {
  const implementationSources = listRealtimeArtifacts(stateDir, /^implementation-review-round-\d+\.source\.txt$/);
  const implementationVerdicts = implementationSources
    .map(({ round, path }) => {
      const verdict = parseReviewVerdictFromSource(path);
      return verdict ? `r${round}=${verdict}` : null;
    })
    .filter((value): value is string => Boolean(value));

  const planSources = listRealtimeArtifacts(stateDir, /^plan-review-round-\d+\.source\.txt$/);
  const planErrors = listRealtimeArtifacts(stateDir, /^plan-review-round-\d+\.error\.txt$/);
  const lastPlanReviewError = planErrors.length > 0
    ? readTextFileIfExists(planErrors[planErrors.length - 1].path) ?? undefined
    : undefined;

  return {
    implementationRounds: implementationSources.length,
    implementationVerdicts,
    planReviewRounds: planSources.length,
    lastPlanReviewError,
  };
}

function getRealtimeImplementationReviewLoops(jobId: string): number {
  if (!jobId) return 0;
  return collectRealtimeReviewDiagnostics(join(REALTIME_STATE_ROOT, jobId)).implementationRounds;
}

export function __collectRealtimeReviewDiagnosticsForTests(stateDir: string): RealtimeReviewDiagnostics {
  return collectRealtimeReviewDiagnostics(stateDir);
}

function isLikelyRealtimePlanSummary(result: LatestRealtimeResult | null): boolean {
  const text = result?.resultText?.trim() ?? "";
  if (!text) return false;
  return /^plan summary:/i.test(text);
}

function isSubstantiveRealtimeSuccess(result: LatestRealtimeResult | null): boolean {
  if (!result?.resultText) return false;
  if (result.isError === true) return false;
  if (result.subtype && result.subtype !== "success") return false;
  if (isLikelyRealtimePlanSummary(result)) return false;
  if ((result.permissionDenials ?? []).includes("ExitPlanMode")) return false;
  return true;
}

function classifyPlanViolationHandling(
  stateDir: string,
  goal: "round-complete" | "terminal",
): "defer" | "waiting" | "terminal" {
  if (goal !== "round-complete") {
    return "terminal";
  }

  const latestResult = readLatestRealtimeResult(stateDir);
  if (isSubstantiveRealtimeSuccess(latestResult)) {
    return "waiting";
  }

  const hasExitPlanModeDenial = (latestResult?.permissionDenials ?? []).includes("ExitPlanMode");
  if (hasExitPlanModeDenial || isLikelyRealtimePlanSummary(latestResult)) {
    return "defer";
  }

  return "terminal";
}

export function __classifyPlanViolationHandlingForTests(
  stateDir: string,
  goal: "round-complete" | "terminal" = "round-complete",
): "defer" | "waiting" | "terminal" {
  return classifyPlanViolationHandling(stateDir, goal);
}

export function __readLatestRealtimeResultForTests(stateDir: string): LatestRealtimeResult | null {
  return readLatestRealtimeResult(stateDir);
}

function parseRealtimeStateDir(output: string, jobId: string): string {
  const match = output.match(/BG:(\/tmp\/claude-realtime\/[^\s]+)/);
  return match?.[1] ?? join(REALTIME_STATE_ROOT, jobId);
}

function buildRealtimeSummary(
  stateDir: string,
  status: string,
  extraDetail?: string,
): { summary: string; sessionId?: string } {
  const latestResult = readLatestRealtimeResult(stateDir);
  const reviewDiagnostics = collectRealtimeReviewDiagnostics(stateDir);
  const verifyReport = readTextFileIfExists(join(stateDir, "verify-report.txt"));
  const outputLog = readTextFileIfExists(join(stateDir, "output.log"));

  const sections = [`claude-realtime job ${basename(stateDir)} status=${status}`];

  if (latestResult?.resultText) {
    const metadata = [
      latestResult.numTurns != null ? `turns=${latestResult.numTurns}` : "",
      latestResult.costUsd != null ? `cost=$${latestResult.costUsd.toFixed(2)}` : "",
    ].filter(Boolean).join(", ");
    sections.push([
      `Latest worker result (Claude Code)${metadata ? ` (${metadata})` : ""}:`,
      tailText(latestResult.resultText, 16, 1600),
    ].join("\n"));
  }

  if (reviewDiagnostics.implementationRounds > 0) {
    sections.push(
      `Implementation reviews: ${reviewDiagnostics.implementationRounds}`
      + (reviewDiagnostics.implementationVerdicts.length > 0
        ? ` (${reviewDiagnostics.implementationVerdicts.join(", ")})`
        : ""),
    );
  }

  if (reviewDiagnostics.planReviewRounds > 0) {
    sections.push(`Embedded plan reviews: ${reviewDiagnostics.planReviewRounds}`);
  }

  if (reviewDiagnostics.lastPlanReviewError) {
    sections.push(`Last embedded plan-review error:\n${tailText(reviewDiagnostics.lastPlanReviewError, 8, 1200)}`);
  }

  if (verifyReport) {
    sections.push(`Verify report:\n${tailText(verifyReport, 24, 2400)}`);
  }

  if (extraDetail) {
    sections.push(extraDetail);
  }

  if (outputLog && status !== "done") {
    sections.push(`Launcher log tail:\n${tailText(outputLog, 30, 2400)}`);
  }

  return {
    summary: sections.join("\n\n"),
    sessionId: latestResult?.sessionId,
  };
}

function readLatestRealtimeResult(
  stateDir: string,
): LatestRealtimeResult | null {
  try {
    if (!existsSync(stateDir)) return null;

    const candidates: Array<LatestRealtimeResult & { sourcePriority: number }> = [];

    const resultFiles = readdirSync(stateDir)
      .filter((name) => /^result-\d+\.json$/.test(name))
      .sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    for (const filename of resultFiles) {
      const payload = JSON.parse(readFileSync(join(stateDir, filename), "utf-8"));
      candidates.push({
        ...buildLatestRealtimeResult(payload, extractRealtimeRound(filename)),
        sourcePriority: 2,
      });
    }

    const streamFiles = readdirSync(stateDir)
      .filter((name) => /^stream-\d+\.jsonl$/.test(name))
      .sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    for (const filename of streamFiles) {
      const round = extractRealtimeRound(filename);
      const lines = readFileSync(join(stateDir, filename), "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const payload = JSON.parse(trimmed);
          if (payload?.type !== "result") continue;
          candidates.push({
            ...buildLatestRealtimeResult(payload, round),
            sourcePriority: 1,
          });
        } catch {
          continue;
        }
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const roundDelta = (a.round ?? 0) - (b.round ?? 0);
      if (roundDelta !== 0) return roundDelta;
      return a.sourcePriority - b.sourcePriority;
    });

    const latest = candidates[candidates.length - 1];
    const { sourcePriority: _sourcePriority, ...result } = latest;
    return result;
  } catch {
    return null;
  }
}

function buildLatestRealtimeResult(payload: any, round: number): LatestRealtimeResult {
  const permissionDenials = Array.isArray(payload?.permission_denials)
    ? payload.permission_denials
        .map((entry: any) => typeof entry?.tool_name === "string" ? entry.tool_name : null)
        .filter((value: string | null): value is string => Boolean(value))
    : [];

  return {
    sessionId: typeof payload?.session_id === "string" ? payload.session_id : undefined,
    resultText: typeof payload?.result === "string" ? payload.result : undefined,
    numTurns: typeof payload?.num_turns === "number" ? payload.num_turns : undefined,
    costUsd: typeof payload?.total_cost_usd === "number" ? payload.total_cost_usd : undefined,
    subtype: typeof payload?.subtype === "string" ? payload.subtype : undefined,
    isError: typeof payload?.is_error === "boolean" ? payload.is_error : undefined,
    round,
    permissionDenials,
  };
}

function recoverSuccessfulRealtimeTerminalState(
  stateDir: string,
  observedStatus: string,
): { status: string; summary: string; sessionId?: string } | null {
  const latestResult = readLatestRealtimeResult(stateDir);
  if (!latestResult?.resultText) return null;
  if (latestResult.isError === true) return null;
  if (latestResult.subtype && latestResult.subtype !== "success") return null;

  const feedbackHistory = readTextFileIfExists(join(stateDir, "feedback-history.log")) ?? "";
  const hasDoneFeedback = /(^|\n)DONE(\n|$)/m.test(feedbackHistory);
  if (!hasDoneFeedback && observedStatus !== "done") return null;

  return {
    status: "done",
    ...buildRealtimeSummary(
      stateDir,
      "done",
      `Recovered terminal success after late ${observedStatus} status override.`,
    ),
  };
}

function isRealtimeReviewReadyStatus(status: string): boolean {
  return status === "waiting" || status === "done";
}

function buildRealtimeWorkerResult(
  taskId: string,
  status: string,
  summary: string,
  sessionId: string,
): WorkerResult {
  return {
    taskId,
    status: isRealtimeReviewReadyStatus(status) ? "completed" : "failed",
    summary,
    filesChanged: extractFilePaths(summary),
    testsRun: extractTestCount(summary),
    warnings: extractWarnings(summary),
    sessionId,
  };
}

function recoverCompletedRealtimeWorkerResult(
  taskId: string,
  jobId: string,
): WorkerResult | null {
  if (!jobId) return null;

  const stateDir = join(REALTIME_STATE_ROOT, jobId);
  const status = readRealtimeStatus(stateDir);
  if (status !== "done") {
    return null;
  }

  const { summary, sessionId } = buildRealtimeSummary(stateDir, status);
  return buildRealtimeWorkerResult(taskId, status, summary, sessionId ?? jobId);
}

function extractRealtimeRound(filename: string): number {
  const match = filename.match(/^(?:result|stream)-(\d+)\.(?:json|jsonl)$/);
  return match ? parseInt(match[1], 10) : 0;
}

function readTextFileIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function tailText(text: string, maxLines: number, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const tailLines = trimmed.split("\n").slice(-maxLines).join("\n");
  if (tailLines.length <= maxChars) {
    return tailLines;
  }
  return tailLines.slice(-maxChars);
}

function formatRealtimeFailure(
  jobId: string,
  stateDir: string,
  status: string,
  summary: string,
): string {
  return [
    `Tier 2 realtime job ${jobId} ended with status=${status}.`,
    `State dir: ${stateDir}`,
    summary ? `Details:\n${summary}` : "",
  ].filter(Boolean).join("\n");
}

function buildRealtimeSpec(task: TaskSpec, plan: HarnessPlan, workdir: string): string {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria
    : ["Complete the requested change without expanding scope."];

  return [
    "## Goal",
    task.title,
    "",
    `Original request: ${plan.originalRequest}`,
    "",
    "## Scope",
    `- Working directory: \`${workdir}\``,
    `- 수정: ${task.scope}`,
    `- 금지: Do not change unrelated legacy registration, gating, or harness architecture outside this task.`,
    "",
    "## Acceptance Criteria",
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Context",
    `- Harness plan: ${plan.id}`,
    `- Task id: ${task.id}`,
    `- Plan mode: ${plan.mode}`,
    `- Estimated complexity: ${plan.estimatedComplexity}`,
  ].join("\n");
}

function buildRealtimeJobId(planId: string, taskId: string): string {
  const planPart = sanitizeRealtimeFragment(planId).slice(0, 32);
  const taskPart = sanitizeRealtimeFragment(taskId).slice(0, 24);
  return `harness-${planPart || "plan"}-${taskPart || "task"}-${Date.now()}`;
}

function hasRealtimeProjectContext(workdir: string): boolean {
  return existsSync(join(workdir, "CLAUDE.md")) || existsSync(join(workdir, ".claude", "CLAUDE.md"));
}

function assertRealtimeProjectContext(workdir: string): void {
  if (hasRealtimeProjectContext(workdir)) {
    return;
  }
  throw new Error(
    [
      `Realtime worker requires project context before launch: ${workdir}`,
      "Missing CLAUDE.md (or .claude/CLAUDE.md).",
      "Create a project context file before using harness_execute with the realtime worker.",
    ].join("\n"),
  );
}

export function __hasRealtimeProjectContextForTests(workdir: string): boolean {
  return hasRealtimeProjectContext(workdir);
}

export function __formatReviewOnlyResultForTests(
  plan: HarnessPlan,
  workerResult: WorkerResult,
  reviewResult: ReviewResult,
  reviewLoop: ReturnType<typeof initReviewLoop>,
  action: string,
): string {
  return formatReviewOnlyResult(plan, workerResult, reviewResult, reviewLoop, action);
}

function sanitizeRealtimeFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferAgentIdFromWorkdir(workdir: string): string | undefined {
  const normalized = resolve(workdir);
  const workspaceMatch = normalized.match(/\/workspace-([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (workspaceMatch?.[1]) {
    return workspaceMatch[1];
  }

  const agentsMatch = normalized.match(/\/agents\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (agentsMatch?.[1]) {
    return agentsMatch[1];
  }

  return undefined;
}

function resolveCallerAgentId(ctx: OpenClawPluginToolContext): string {
  return ctx.agentId
    || ctx.agentAccountId
    || process.env.OPENCLAW_NOTIFY_AGENT_DEFAULT
    || "nova";
}

function resolveRealtimeNotifyAgent(ctx: OpenClawPluginToolContext, workdir: string): string {
  return inferAgentIdFromWorkdir(workdir)
    || resolveCallerAgentId(ctx);
}

function formatRealtimeFailureForCaller(
  ctx: OpenClawPluginToolContext,
  workdir: string,
  detailedError: string,
): string {
  const callerAgent = resolveCallerAgentId(ctx);
  const targetAgent = resolveRealtimeNotifyAgent(ctx, workdir);
  if (targetAgent !== callerAgent) {
    return `Tier 2 failure was routed to ${targetAgent}. Detailed error was sent to that agent's channel.`;
  }
  return detailedError;
}

function resolveRealtimeModel(workerModel: string): "opus" | "sonnet" {
  return workerModel.toLowerCase().includes("opus") ? "opus" : "sonnet";
}

function resolveSubagentProviderAndModel(
  requestedModel: string,
  fallback: { provider: string; model: string },
): { provider: string; model: string } {
  const raw = (requestedModel ?? "").trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw.includes("/")) {
    const [provider, model] = raw.split("/", 2);
    if (provider && model) {
      return { provider, model };
    }
  }

  if (
    lower === "codex"
    || lower === "gpt5.4"
    || lower === "gpt-5.4"
    || lower === "gpt"
  ) {
    return { provider: "openai-codex", model: "gpt-5.4" };
  }

  if (
    lower === "opus"
    || lower === "opus46"
    || lower === "claude-opus-4-6"
  ) {
    return { provider: "anthropic", model: "claude-opus-4-6" };
  }

  if (
    lower === "claude"
    || lower === "sonnet"
    || lower === "sonnet46"
    || lower === "claude-sonnet-4-6"
  ) {
    return { provider: "anthropic", model: "claude-sonnet-4-6" };
  }

  if (lower.includes("codex") || lower.startsWith("gpt")) {
    return { provider: "openai-codex", model: "gpt-5.4" };
  }

  if (lower.includes("opus")) {
    return { provider: "anthropic", model: "claude-opus-4-6" };
  }

  if (lower.includes("claude") || lower.includes("sonnet")) {
    return { provider: "anthropic", model: "claude-sonnet-4-6" };
  }

  return fallback;
}

export function resolveEmbeddedReviewerProviderAndModel(
  reviewModel?: string,
  fallbackModel?: string,
): { provider: string; model: string } {
  const normalizedModel = resolveModelAlias(reviewModel ?? fallbackModel)
    ?? reviewModel?.trim()
    ?? fallbackModel?.trim()
    ?? "openai-codex/gpt-5.4";

  return resolveSubagentProviderAndModel(normalizedModel, {
    provider: "openai-codex",
    model: "gpt-5.4",
  });
}

function buildHarnessSubagentSessionKey(
  agentId: string,
  planId: string,
  taskId: string,
  role: "worker" | "reviewer",
): string {
  // OpenAI prompt_cache_key is capped at 64 chars. Openclaw prepends ~46
  // chars of runtime prefix (provider, model hash, workspace, etc.) before
  // the sessionKey when deriving the cache key. That leaves only ~18 chars
  // for the sessionKey portion. Hash all inputs into a short stable digest.
  const composite = `${planId}|${taskId}|${role}`;
  const hash = createHash("sha256").update(composite).digest("hex").slice(0, 12);
  return `h${hash}`;
}

async function getLatestSubagentAssistantText(
  runtime: any,
  sessionKey: string,
  role: "worker" | "reviewer",
): Promise<string> {
  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const msgs = await runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
    console.log(
      `[harness] ${role} getSessionMessages: key=${sessionKey}, attempt=${attempt}/${maxAttempts}, count=${msgs?.messages?.length ?? 0}`,
    );

    const assistants = msgs?.messages?.filter((m: any) => m.role === "assistant") ?? [];
    const rawContent = assistants.pop()?.content ?? "";
    const flattened = flattenSubagentMessageContent(rawContent).trim();

    console.log(
      `[harness] ${role} rawContent type=${typeof rawContent}, isArray=${Array.isArray(rawContent)}, textChars=${flattened.length}`,
    );

    if (flattened) {
      return flattened;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(250 * attempt, 1000)));
    }
  }

  return "";
}

function flattenSubagentMessageContent(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (typeof item === "string") {
          return item;
        }
        return item?.text ?? item?.content ?? "";
      })
      .join("\n");
  }
  return String(content ?? "");
}

async function cleanupHarnessSubagentSessions(
  runtime: any,
  sessionKeys: Array<string | undefined>,
): Promise<void> {
  if (!runtime?.subagent?.deleteSession) {
    return;
  }

  const uniqueSessionKeys = [...new Set(sessionKeys.filter((sessionKey): sessionKey is string => !!sessionKey))];
  for (const sessionKey of uniqueSessionKeys) {
    try {
      await runtime.subagent.deleteSession({ sessionKey });
    } catch (err: any) {
      console.warn(
        `[harness] Failed to cleanup subagent session ${sessionKey}: ${err?.message ?? String(err)}`,
      );
    }
  }
}

/**
 * Wait for a session to reach terminal state and return status + output.
 */
async function waitForSessionEnd(sessionId: string): Promise<SessionCompletion> {
  const activeSessionManager = requireHarnessSessionManager();
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes max
  const pollIntervalMs = 3000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const session = activeSessionManager.get(sessionId);
    if (!session) {
      return { status: "failed", output: "", error: "Session disappeared" };
    }

    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return {
        status: session.status,
        output: session.getOutput().join("\n"),
        error: session.error,
      };
    }

    await sleep(pollIntervalMs);
  }

  console.warn(`[harness] Timeout waiting for session ${sessionId}`);
  // Kill the timed-out session
  activeSessionManager.kill(sessionId);
  return { status: "timeout", output: "", error: "Session timed out after 10 minutes" };
}

/**
 * Wait for a session to complete successfully and extract a WorkerResult.
 * Returns null if the session failed, was killed, or timed out.
 */
async function waitForCompletion(sessionId: string, taskId: string): Promise<WorkerResult | null> {
  const completion = await waitForSessionEnd(sessionId);

  if (completion.status !== "completed") {
    console.warn(`[harness] Worker session ${sessionId} ended with status=${completion.status}: ${completion.error}`);
    return null;
  }

  if (!completion.output) return null;

  return {
    taskId,
    status: "completed",
    summary: completion.output.length > 500 ? completion.output.slice(-500) : completion.output,
    filesChanged: extractFilePaths(completion.output),
    testsRun: extractTestCount(completion.output),
    warnings: extractWarnings(completion.output),
    sessionId,
  };
}

/**
 * Wait for a session to complete and return its output (for reviewer).
 * Returns empty string on failure.
 */
async function waitForOutput(sessionId: string): Promise<string> {
  const completion = await waitForSessionEnd(sessionId);
  if (completion.status !== "completed") {
    console.warn(`[harness] Session ${sessionId} ended with status=${completion.status}: ${completion.error}`);
    return "";
  }
  return completion.output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Notification helper for async completion ──

async function sendHarnessNotification(
  channel: string | undefined,
  ctx: OpenClawPluginToolContext,
  message: string,
): Promise<void> {
  try {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFileCb);

    // Try openclaw message send CLI (works with any configured channel)
    const target = channel || pluginConfig.fallbackChannel;
    if (!target || target === "unknown") {
      console.warn(`[harness] No notification channel available, logging result only`);
      return;
    }

    // Parse channel format: "telegram|account|chatId" or "telegram|chatId"
    const parts = target.split("|");
    const args = ["message", "send", "--message", message.slice(0, 4000)];
    if (parts.length >= 2) {
      args.push("--channel", parts[0]);
    }
    if (parts.length >= 3) {
      // 3-segment: channel|account|target
      args.push("-t", parts[2]);
    } else if (parts.length === 2) {
      // 2-segment: channel|target
      args.push("-t", parts[1]);
    }

    await execFileAsync("openclaw", args, { timeout: 15000 });
  } catch (err: any) {
    console.warn(`[harness] Notification send failed: ${err?.message ?? String(err)}`);
  }
}

// ── Analysis mode detection ──

// Analysis mode: only for SHORT, clearly read-only requests.
// Long requests (specs, PRDs) naturally contain analysis words in their body
// and must NOT be classified as analysis-only.
const MAX_ANALYSIS_REQUEST_LENGTH = 500;
const ANALYSIS_KEYWORDS_KO = /(분석|검토|조사|확인|현황|리뷰|점검|비교|상태|살펴|파악)/;
const ANALYSIS_KEYWORDS_EN = /\b(analy[sz]e|review|inspect|audit|check|status|compare|investigate|examine|diagnose)\b/i;
// Korean word boundary doesn't work with \b — use lookahead/behind or no boundary
const CODING_SIGNALS = /(create|add|implement|fix|update|modify|write|build|refactor|delete|remove|생성|추가|구현|수정|작성|만들|고쳐|삭제|제거|리팩토링)/i;

function isAnalysisOnlyRequest(request: string): boolean {
  // Long requests are never analysis-only (PRDs, specs contain analysis words naturally)
  if (request.length > MAX_ANALYSIS_REQUEST_LENGTH) return false;

  const hasAnalysis = ANALYSIS_KEYWORDS_KO.test(request) || ANALYSIS_KEYWORDS_EN.test(request);
  const hasCoding = CODING_SIGNALS.test(request);
  return hasAnalysis && !hasCoding;
}

export function extractFilePaths(output: string): string[] {
  return extractRelevantFilePaths(output);
}

export function extractRelevantFilePaths(output: string, repoRoot?: string): string[] {
  const paths: string[] = [];
  const root = repoRoot ? resolve(repoRoot) : null;
  const regex = /(?:^|[\s`'"(\[])(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+|\/[\w./-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),:;\]])/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    let candidate = match[1].trim();
    if (!candidate) continue;
    if (candidate.startsWith("/")) {
      if (!root || !candidate.startsWith(root + "/")) continue;
      candidate = relative(root, candidate);
    }
    candidate = candidate.replace(/^\.\//, "");
    if (!candidate || candidate.startsWith("../") || candidate === "..") continue;
    paths.push(candidate);
  }
  return [...new Set(paths)];
}

function extractTestCount(output: string): number {
  const match = output.match(/(\d+)\s*(?:tests?|specs?)\s*(?:passed|ran|ok)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function extractWarnings(output: string): string[] {
  const warnings: string[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    if (/\b(?:warning|warn|⚠️)\b/i.test(line)) {
      warnings.push(line.trim());
    }
  }
  return warnings.slice(0, 10); // cap at 10
}

// --- Risk detection ---

// --- Prompt builders ---

function buildWorkerPrompt(task: TaskSpec, plan: HarnessPlan): string {
  return [
    `## Task: ${task.title}`,
    ``,
    `**Original request:** ${plan.originalRequest}`,
    ``,
    `**Scope:** ${task.scope}`,
    ``,
    `**Acceptance criteria:**`,
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `## Rules`,
    `- Stay within the specified scope. Do not add features beyond what is requested.`,
    `- Do not modify files outside the scope unless absolutely necessary.`,
    `- When done, summarize: files changed, tests run, warnings.`,
    `- If you encounter ambiguity, make the simplest reasonable choice and document it.`,
  ].join("\n");
}

// --- Formatters ---

function formatPlannerMetadata(metadata?: HarnessPlan["plannerMetadata"]): string[] {
  if (!metadata) return [];

  const lines = [
    `**Planner:** ${metadata.backend}${metadata.model ? ` | model=${metadata.model}` : ""} | fallback=${metadata.fallback ? "yes" : "no"}`,
  ];

  if (metadata.fallbackReason) {
    lines.push(`**Planner fallback:** ${metadata.fallbackReason}`);
  }

  return lines;
}

function formatFinalResult(
  plan: HarnessPlan,
  route: import("../router").RouteResult,
  results: TaskExecutionResult[],
  mode: "autonomous",
  checkpoint: CheckpointData,
  runState: ExecutionRunState,
  materialized?: { applied: boolean; patchPath?: string; error?: string } | null,
): string {
  const passed = results.filter((r) => r.reviewPassed).length;
  const failed = results.filter((r) => !r.reviewPassed).length;
  const escalated = results.filter((r) => r.escalated).length;
  const totalLoops = results.reduce((sum, r) => sum + r.reviewLoops, 0);

  const status = failed === 0 ? "success" : escalated > 0 ? "escalated" : "partial";

  const lines = [
    `## Harness: ${status === "success" ? "Complete" : status === "escalated" ? "Escalation Required" : "Partial Completion"}`,
    ``,
    `**Tier:** ${route.tier} | **Mode:** ${mode} | **Plan:** ${plan.id}`,
    `**Run:** ${runState.mode === "resumed" ? "resumed from checkpoint" : "fresh"}`,
    `**Result:** ${passed}/${plan.tasks.length} passed | ${totalLoops} review loops`,
    `**Checkpoint:** ${checkpoint.runId}`,
    ...formatPlannerMetadata(plan.plannerMetadata),
  ];

  if (runState.mode === "resumed") {
    lines.push(
      `**Skipped completed:** ${formatTaskIdList(runState.skippedCompletedTaskIds)}`,
      `**Continued tasks:** ${formatTaskIdList(runState.resumedTaskIds)}`,
    );
  }

  if (materialized?.error) {
    lines.push(`**Workspace materialization:** failed`, `**Patch:** ${materialized.patchPath ?? "(none)"}`, `**Reason:** ${materialized.error}`);
  } else if (materialized?.applied) {
    lines.push(`**Workspace materialization:** applied${materialized.patchPath ? ` (${materialized.patchPath})` : ""}`);
  }

  lines.push(``, `### Task Results`);

  for (const r of results) {
    const icon = r.reviewPassed ? "✅" : r.escalated ? "🚨" : "❌";
    lines.push(`${icon} **${r.taskId}** — reviews: ${r.reviewLoops}, passed: ${r.reviewPassed}`);
    if (r.workerResult) {
      if (r.workerResult.filesChanged.length > 0) {
        lines.push(`   Files: ${r.workerResult.filesChanged.join(", ")}`);
      }
    }
    if (r.error) {
      lines.push(`   Error: ${r.error}`);
    }
    if (r.escalationReason) {
      lines.push(``, r.escalationReason);
    }
  }

  return lines.join("\n");
}

/**
 * Parse subagent text output into a WorkerResult.
 * Subagent returns free-text, so we extract what we can.
 */
function parseWorkerOutput(text: string, taskId: string): WorkerResult | null {
  if (!text || text.trim().length === 0) return null;

  // Try to extract file paths mentioned in the output
  const filePatterns = text.match(/(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml|sh|css|html|toml))/g) ?? [];
  const uniqueFiles = [...new Set(filePatterns)].slice(0, 20);

  return {
    taskId,
    status: "completed",
    summary: text.slice(0, 500),
    filesChanged: uniqueFiles,
    testsRun: 0,
    warnings: [],
  };
}

type CheckpointTaskState = CheckpointData["tasks"][number];

function freshExecutionRunState(): ExecutionRunState {
  return {
    mode: "fresh",
    skippedCompletedTaskIds: [],
    resumedTaskIds: [],
  };
}

function buildExecutionRunState(checkpoint: CheckpointData): ExecutionRunState {
  if (!hasCheckpointProgress(checkpoint)) {
    return freshExecutionRunState();
  }

  const skippedCompletedTaskIds = checkpoint.plan.tasks
    .map((task) => task.id)
    .filter((taskId) => isCheckpointTaskComplete(getCheckpointTask(checkpoint, taskId)));

  const pendingTaskIds = new Set(getPendingTasks(checkpoint));
  const resumedTaskIds = checkpoint.plan.tasks
    .map((task) => task.id)
    .filter((taskId) => {
      const task = getCheckpointTask(checkpoint, taskId);
      return pendingTaskIds.has(taskId) || (task != null && !isCheckpointTaskComplete(task));
    });

  return {
    mode: "resumed",
    skippedCompletedTaskIds,
    resumedTaskIds,
  };
}

function hasCheckpointProgress(checkpoint: CheckpointData): boolean {
  return checkpoint.tasks.some((task) => task.status !== "pending")
    || Object.keys(checkpoint.sessions).length > 0;
}

function getCheckpointTask(
  checkpoint: CheckpointData,
  taskId: string,
): CheckpointTaskState | undefined {
  return checkpoint.tasks.find((task) => task.id === taskId);
}

function isCheckpointTaskComplete(task: CheckpointTaskState | undefined): boolean {
  return task?.status === "completed" && task.reviewPassed === true;
}

function buildCompletedCheckpointResult(
  checkpoint: CheckpointData,
  taskId: string,
): TaskExecutionResult | null {
  const task = getCheckpointTask(checkpoint, taskId);
  if (!isCheckpointTaskComplete(task)) {
    return null;
  }

  return {
    taskId,
    workerSessionId: checkpoint.sessions[taskId]?.worker ?? task.workerResult?.sessionId ?? "",
    workerResult: task.workerResult ?? null,
    reviewPassed: true,
    reviewLoops: task.reviewLoop ?? 0,
    escalated: false,
  };
}

function resetCheckpointTaskForRetry(
  checkpoint: CheckpointData,
  taskId: string,
): void {
  const task = getCheckpointTask(checkpoint, taskId);
  if (!task || isCheckpointTaskComplete(task)) {
    return;
  }

  delete task.reviewPassed;
  delete task.reviewLoop;
  delete task.workerResult;
  delete task.reviewResult;
}

function formatTaskIdList(taskIds: string[]): string {
  if (taskIds.length === 0) {
    return "none";
  }
  return taskIds.join(", ");
}
