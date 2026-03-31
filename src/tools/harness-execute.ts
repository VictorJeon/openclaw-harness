import { execFile } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig, getPluginRuntime } from "../shared";
import { classifyRequest } from "../router";
import { buildPlan, searchMemory } from "../planner";
import {
  getPendingTasks,
  initCheckpoint,
  loadCheckpoint,
  recordSession,
  saveCheckpoint,
  updateTaskStatus,
} from "../checkpoint";
import { initReviewLoop, processReviewResult, formatEscalation, buildReviewRequest } from "../review-loop";
import { parseReviewOutput, REVIEWER_SYSTEM_PROMPT } from "../reviewer";
import type {
  OpenClawPluginToolContext,
  HarnessPlan,
  OperationMode,
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
 *   4. Dispatcher spawns single-turn Worker sessions
 *   5. Waits for Worker completion → extracts WorkerResult
 *   6. Spawns Reviewer session (cross-model) → parses ReviewResult
 *   7. Review loop: fix → rereview (max N cycles)
 *   8. Checkpoint updated at each step
 *   9. Returns structured result or escalation
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
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("ask"),
            Type.Literal("delegate"),
            Type.Literal("autonomous"),
          ],
          {
            description:
              "Operation mode override. ask=all approvals, delegate=auto safe ops (default), autonomous=fully auto",
          },
        ),
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
      approved_plan_id: Type.Optional(
        Type.String({
          description:
            "Plan ID from a previous approval-gated response. Pass this to skip the approval gate and execute the approved plan.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      if (!sessionManager) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Error: SessionManager not initialized. The harness service must be running.",
          }],
        };
      }

      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      const mode: OperationMode = params.mode ?? pluginConfig.operationMode ?? "delegate";
      const maxBudgetUsd = params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5;

      // Step 1: Route — classify request complexity
      const route = classifyRequest(params.request);
      const tier = params.tier_override ?? route.tier;

      console.log(`[harness] Route: tier=${tier}, confidence=${route.confidence}, reason=${route.reason}`);

      // Step 2: Approval gate
      const isRiskyConfig = isRiskyTier0(params.request); // evaluate independently of tier

      // If approved_plan_id provided, load and validate the persisted plan
      if (params.approved_plan_id) {
        const existingCheckpoint = loadCheckpoint(params.approved_plan_id, workdir);
        if (!existingCheckpoint) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Error: approved_plan_id "${params.approved_plan_id}" not found. It may have expired or the workdir doesn't match.`,
            }],
          };
        }

        // Verify the approved plan matches the current request
        if (existingCheckpoint.plan.originalRequest !== params.request) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Error: approved_plan_id "${params.approved_plan_id}" was created for a different request. Cannot reuse approval across different requests.`,
            }],
          };
        }

        // Execute the approved plan directly
        console.log(`[harness] Executing approved plan: ${params.approved_plan_id}`);
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
        const taskResults = await executePlan(plan, workdir, maxBudgetUsd, ctx, existingCheckpoint);

        return {
          content: [{
            type: "text",
            text: formatFinalResult(plan, route, taskResults, mode, existingCheckpoint, runState),
          }],
        };
      }

      // No approval token — check gates
      const needsApproval =
        (mode === "ask" && (tier > 0 || isRiskyConfig)) ||
        (isRiskyConfig && mode !== "autonomous") ||
        (mode === "delegate" && tier === 2);

      if (needsApproval) {
        const plan = buildPlan(params.request, tier > 0 ? tier : 1);
        // Persist the plan so approved_plan_id can load it later
        const checkpoint = initCheckpoint(plan, workdir);
        checkpoint.status = "running"; // mark as awaiting approval
        return {
          content: [{
            type: "text",
            text: formatPlanForApproval(plan, route, mode),
          }],
        };
      }

      // Tier 0 (non-risky): direct execution by the OpenClaw agent
      if (tier === 0) {
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

      // Step 3: Memory V3 prefetch (best-effort)
      let memoryContext = "";
      try {
        memoryContext = await searchMemory(workdir.split("/").pop() ?? "project");
      } catch {
        // non-fatal
      }

      // Step 4: Plan
      const plan = buildPlan(params.request, tier, memoryContext);
      console.log(`[harness] Plan: id=${plan.id}, tasks=${plan.tasks.length}, mode=${plan.mode}`);

      // Step 5: Initialize checkpoint
      const checkpoint = initCheckpoint(plan, workdir);

      // Step 6: Execute tasks (sequential or parallel based on plan.mode)
      const taskResults = await executePlan(plan, workdir, maxBudgetUsd, ctx, checkpoint);

      // Step 7: Format final result
      return {
        content: [{
          type: "text",
          text: formatFinalResult(plan, route, taskResults, mode, checkpoint, freshExecutionRunState()),
        }],
      };
    },
  };
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
const REALTIME_LAUNCH_TIMEOUT_MS = 90_000;
const REALTIME_POLL_INTERVAL_MS = 5_000;
const REALTIME_MAX_WAIT_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;

interface RealtimeLaunchResult {
  jobId: string;
  stateDir: string;
  output: string;
}

interface RealtimeExecutionResult extends RealtimeLaunchResult {
  status: string;
  workerResult: WorkerResult | null;
  error?: string;
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
      const hasSlot = await sessionManager!.waitForSlot();
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
      const batchSize = Math.max(1, Math.floor(sessionManager!.availableSlots() / 2));
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
  const workerModel = pluginConfig.workerModel ?? "claude";
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const isTier2Realtime = plan.tier === 2;
  const runtime = getPluginRuntime();
  const useSubagent = runtime?.subagent?.run != null;
  const agentId = ctx.agentId ?? "main";
  const workerSubagentSessionKey = !isTier2Realtime && useSubagent
    ? buildHarnessSubagentSessionKey(agentId, plan.id, task.id, "worker")
    : undefined;
  const reviewerSubagentSessionKey = useSubagent
    ? buildHarnessSubagentSessionKey(agentId, plan.id, task.id, "reviewer")
    : undefined;

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

  try {
    resetCheckpointTaskForRetry(checkpoint, task.id);

    // --- Worker phase ---
    updateTaskStatus(checkpoint, task.id, "in-progress", workdir);

    const workerPrompt = buildWorkerPrompt(task, plan);
    let workerResult: WorkerResult | null = null;

    if (isTier2Realtime) {
      workerSessionId = buildRealtimeJobId(plan.id, task.id);
      const realtimeResult = await executeTier2RealtimeTask(
        task,
        plan,
        workdir,
        ctx,
        workerModel,
        workerSessionId,
      );
      recordSession(checkpoint, task.id, "worker", workerSessionId, workdir);

      if (realtimeResult.status !== "done" || !realtimeResult.workerResult) {
        updateTaskStatus(checkpoint, task.id, "failed", workdir, {
          workerResult: realtimeResult.workerResult ?? undefined,
        });
        return {
          taskId: task.id,
          workerSessionId,
          workerResult: realtimeResult.workerResult,
          reviewPassed: false,
          reviewLoops: 0,
          escalated: true,
          error: realtimeResult.error ?? `Tier 2 realtime job ${workerSessionId} ended with status=${realtimeResult.status}`,
        };
      }

      workerResult = realtimeResult.workerResult;
    } else if (useSubagent) {
      // === ACP/Subagent path: real cross-model (tier 0/1 only) ===
      const workerIdempotencyKey = `harness-worker-${plan.id}-${task.id}-${Date.now()}`;
      const workerRunParams = {
        idempotencyKey: workerIdempotencyKey,
        sessionKey: workerSubagentSessionKey,
        message: [
          `## Working Directory`,
          `All file operations MUST use absolute paths under: ${workdir}`,
          `Create the directory first if it doesn't exist: mkdir -p ${workdir}`,
          ``,
          workerPrompt,
        ].join("\n"),
        provider: workerModel === "codex" ? "openai-codex" : "anthropic",
        model: workerModel === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
        deliver: false,
      };
      console.log(`[harness] Worker subagent.run params: ${JSON.stringify(workerRunParams)}`);
      const { runId } = await runtime.subagent.run(workerRunParams);
      workerSessionId = workerSubagentSessionKey ?? "";
      console.log(`[harness] Worker subagent.run returned runId=${runId}`);
      const completion = await runtime.subagent.waitForRun({ runId, timeoutMs: 600000 });
      console.log(`[harness] Worker waitForRun result: status=${completion?.status}, error=${completion?.error}`);
      if (completion?.status === "error") {
        throw new Error(`Worker subagent failed: ${completion.error ?? "unknown"}`);
      }
      const lastMsg = await getLatestSubagentAssistantText(runtime, workerSessionId, "worker");
      workerResult = parseWorkerOutput(lastMsg, task.id);
    } else {
      // === Fallback: sessionManager.spawn (CC PTY) ===
      console.warn(`[harness] Fallback to sessionManager.spawn (no runtime.subagent)`);
      const workerSession = sessionManager!.spawn({
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
      `[harness] Worker done: task=${task.id}, session=${workerSessionId}, model=${workerModel}, useSubagent=${useSubagent}, tier2Realtime=${isTier2Realtime}`,
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

    while (!reviewLoop.passed && !reviewLoop.escalated) {
      let reviewResult: ReviewResult | null = null;
      let reviewerRetryCount = 0;

      while (true) {
        const reviewBudget = Math.min(perPhaseBudget, remainingBudget);
        remainingBudget -= reviewBudget;

        const baseReviewPrompt = buildReviewRequest(task, currentWorkerResult, plan.originalRequest, reviewLoop);
        const reviewPrompt = reviewerRetryCount === 0
          ? baseReviewPrompt
          : [
              baseReviewPrompt,
              ``,
              `### Retry Instructions`,
              `Your previous response was malformed.`,
              `Return only the single JSON object required by the system prompt.`,
            ].join("\n");

        let reviewOutput = "";

        if (useSubagent) {
          // === Reviewer via subagent.run — same reviewer session across re-reviews ===
          const isReviewerContinuation = reviewLoop.history.length > 0 || reviewerRetryCount > 0;
          const reviewerMessage = isReviewerContinuation
            ? reviewPrompt
            : REVIEWER_SYSTEM_PROMPT + "\n\n---\n\n" + reviewPrompt;
          console.log(
            `[harness] Reviewer via subagent.run: key=${reviewerSubagentSessionKey}, model=${reviewModel}, continuity=${isReviewerContinuation ? "continue" : "start"}`,
          );
          const { runId: reviewRunId } = await runtime.subagent.run({
            idempotencyKey: `harness-review-${plan.id}-${task.id}-${reviewLoop.history.length + 1}-${Date.now()}`,
            sessionKey: reviewerSubagentSessionKey,
            message: reviewerMessage,
            provider: reviewModel === "codex" ? "openai-codex" : "anthropic",
            model: reviewModel === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
            deliver: false,
          });
          recordSession(checkpoint, task.id, "reviewer", reviewerSubagentSessionKey ?? "", workdir);
          await runtime.subagent.waitForRun({ runId: reviewRunId, timeoutMs: 300000 });
          reviewOutput = await getLatestSubagentAssistantText(
            runtime,
            reviewerSubagentSessionKey ?? "",
            "reviewer",
          );
        } else {
          // === Fallback: sessionManager.spawn ===
          const reviewerSession = sessionManager!.spawn({
            prompt: reviewPrompt,
            name: `harness-${plan.id}-${task.id}-review-${reviewLoop.history.length + 1}`,
            workdir,
            model: reviewModel,
            maxBudgetUsd: reviewBudget,
            systemPrompt: REVIEWER_SYSTEM_PROMPT,
            permissionMode: "default",
            allowedTools: ["Read", "Glob", "Grep", "LS"],
            originChannel: ctx.messageChannel,
            originAgentId: ctx.agentId,
            multiTurn: false,
          });
          recordSession(checkpoint, task.id, "reviewer", reviewerSession.id, workdir);
          reviewOutput = await waitForOutput(reviewerSession.id);
        }

        console.log(
          `[harness] Reviewer done: task=${task.id}, loop=${reviewLoop.history.length + 1}, model=${reviewModel}, retry=${reviewerRetryCount}, useSubagent=${useSubagent}`,
        );

        reviewResult = parseReviewOutput(reviewOutput, task.id);
        if (!reviewResult.retryReviewer) {
          break;
        }

        reviewerRetryCount++;
        if (reviewerRetryCount >= 3) {
          updateTaskStatus(checkpoint, task.id, "failed", workdir, {
            reviewPassed: false,
            reviewLoop: reviewLoop.currentLoop,
          });
          return {
            taskId: task.id,
            workerSessionId,
            workerResult: currentWorkerResult,
            reviewPassed: false,
            reviewLoops: reviewLoop.history.length,
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
        updateTaskStatus(checkpoint, task.id, "completed", workdir, {
          reviewPassed: true,
          reviewLoop: reviewLoop.currentLoop,
          reviewResult,
        });
        return {
          taskId: task.id,
          workerSessionId,
          workerResult: currentWorkerResult,
          reviewPassed: true,
          reviewLoops: reviewLoop.history.length,
          escalated: false,
        };
      }

      if (action.action === "escalate") {
        updateTaskStatus(checkpoint, task.id, "failed", workdir, {
          reviewPassed: false,
          reviewLoop: reviewLoop.currentLoop,
          reviewResult,
        });
        return {
          taskId: task.id,
          workerSessionId,
          workerResult: currentWorkerResult,
          reviewPassed: false,
          reviewLoops: reviewLoop.history.length,
          escalated: true,
          escalationReason: formatEscalation(plan, reviewLoop, task),
        };
      }

      // action === "fix": spawn a fixer session with gap feedback
      if (action.action === "fix") {
        if (isTier2Realtime) {
          updateTaskStatus(checkpoint, task.id, "failed", workdir, {
            reviewPassed: false,
            reviewLoop: reviewLoop.currentLoop,
            reviewResult,
          });
          return {
            taskId: task.id,
            workerSessionId,
            workerResult: currentWorkerResult,
            reviewPassed: false,
            reviewLoops: reviewLoop.history.length,
            escalated: true,
            escalationReason: formatEscalation(plan, reviewLoop, task),
            error: "Tier 2 realtime follow-up fixes are deferred until same-session ping-pong is wired. The realtime run completed, but reviewer-requested fixes still require manual follow-up.",
          };
        }

        const fixBudget = Math.min(perPhaseBudget, remainingBudget);
        remainingBudget -= fixBudget;

        if (useSubagent) {
          // === Fixer via subagent.run — same worker session across fix loops ===
          console.log(
            `[harness] Fixer via subagent.run: key=${workerSessionId}, model=${workerModel}, continuity=continue`,
          );
          const { runId: fixRunId } = await runtime.subagent.run({
            idempotencyKey: `harness-fix-${plan.id}-${task.id}-${reviewLoop.currentLoop}-${Date.now()}`,
            sessionKey: workerSessionId,
            message: `## Working Directory\nAll file operations MUST use absolute paths under: ${workdir}\nCreate the directory first if it doesn't exist: mkdir -p ${workdir}\n\n${action.fixPrompt}`,
            provider: workerModel === "codex" ? "openai-codex" : "anthropic",
            model: workerModel === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
            deliver: false,
          });
          await runtime.subagent.waitForRun({ runId: fixRunId, timeoutMs: 600000 });
          const fixText = await getLatestSubagentAssistantText(runtime, workerSessionId, "worker");
          const fixResult = parseWorkerOutput(fixText, task.id);
          if (fixResult) {
            currentWorkerResult = fixResult;
          }
        } else {
          const fixSession = sessionManager!.spawn({
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

          console.log(
            `[harness] Fixer spawned (fallback): task=${task.id}, session=${fixSession.id}, loop=${reviewLoop.currentLoop}, model=${workerModel}`,
          );

          const fixResult = await waitForCompletion(fixSession.id, task.id);
          if (fixResult) {
            currentWorkerResult = fixResult;
          }
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
      reviewLoops: reviewLoop.history.length,
      escalated: true,
      error: "Review loop exited unexpectedly",
    };
  } catch (err: any) {
    updateTaskStatus(checkpoint, task.id, "failed", workdir);
    return {
      taskId: task.id,
      workerSessionId,
      workerResult: null,
      reviewPassed: false,
      reviewLoops: 0,
      escalated: true,
      error: `${err.message}\n${err.stack ?? ""}`,
    };
  } finally {
    await cleanupHarnessSubagentSessions(runtime, [
      workerSubagentSessionKey,
      reviewerSubagentSessionKey,
    ]);
  }
}

// --- Session completion helpers ---

interface SessionCompletion {
  status: "completed" | "failed" | "killed" | "timeout";
  output: string;
  error?: string;
}

async function executeTier2RealtimeTask(
  task: TaskSpec,
  plan: HarnessPlan,
  workdir: string,
  ctx: OpenClawPluginToolContext,
  workerModel: string,
  jobId: string,
): Promise<RealtimeExecutionResult> {
  const resolvedWorkdir = resolve(workdir);
  const spec = buildRealtimeSpec(task, plan, resolvedWorkdir);
  const realtimeModel = resolveRealtimeModel(workerModel);
  const notifyAgent = resolveRealtimeNotifyAgent(ctx);

  console.log(
    `[harness] Tier 2 worker invoking claude-realtime.sh: script=${REALTIME_SCRIPT_PATH}, jobId=${jobId}, workdir=${resolvedWorkdir}, model=${realtimeModel}, notifyAgent=${notifyAgent}`,
  );

  const launch = await launchRealtimeJob(spec, resolvedWorkdir, jobId, realtimeModel, notifyAgent);
  const terminal = await waitForRealtimeTerminalState(launch.stateDir, launch.jobId);
  const filesChanged = extractFilePaths(terminal.summary);
  const warnings = extractWarnings(terminal.summary);

  return {
    ...launch,
    status: terminal.status,
    workerResult: {
      taskId,
      status: terminal.status === "done" ? "completed" : "failed",
      summary: terminal.summary,
      filesChanged,
      testsRun: terminal.status === "done" ? extractTestCount(terminal.summary) : 0,
      warnings,
      sessionId: terminal.sessionId ?? launch.jobId,
    },
    error: terminal.status === "done"
      ? undefined
      : formatRealtimeFailure(launch.jobId, launch.stateDir, terminal.status, terminal.summary),
  };
}

async function launchRealtimeJob(
  spec: string,
  workdir: string,
  jobId: string,
  model: "opus" | "sonnet",
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
    "--notify-agent",
    notifyAgent,
  ];
  const launch = await execFileCapture("bash", args, workdir);
  const combinedOutput = [launch.stdout, launch.stderr].filter(Boolean).join("\n").trim();
  const stateDir = parseRealtimeStateDir(combinedOutput, jobId);

  if (launch.exitCode !== 0) {
    throw new Error([
      `claude-realtime.sh launch failed (exit ${launch.exitCode})`,
      combinedOutput,
    ].filter(Boolean).join("\n"));
  }

  console.log(
    `[harness] Tier 2 worker launched: jobId=${jobId}, stateDir=${stateDir}, output=${combinedOutput || "(empty)"}`,
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: process.env,
        timeout: REALTIME_LAUNCH_TIMEOUT_MS,
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

async function waitForRealtimeTerminalState(
  stateDir: string,
  jobId: string,
): Promise<{ status: string; summary: string; sessionId?: string }> {
  const startedAt = Date.now();
  let lastStatus = readRealtimeStatus(stateDir) ?? "launching";

  while (Date.now() - startedAt < REALTIME_MAX_WAIT_MS) {
    const currentStatus = readRealtimeStatus(stateDir);
    if (currentStatus) {
      lastStatus = currentStatus;
    }

    if (isRealtimeTerminalStatus(lastStatus)) {
      return {
        status: lastStatus,
        ...buildRealtimeSummary(stateDir, lastStatus),
      };
    }

    await sleep(REALTIME_POLL_INTERVAL_MS);
  }

  const timeoutStatus = "error:timeout";
  return {
    status: timeoutStatus,
    ...buildRealtimeSummary(
      stateDir,
      timeoutStatus,
      `Timed out waiting for realtime terminal status. Last observed status: ${lastStatus}.`,
    ),
  };
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
  const verifyReport = readTextFileIfExists(join(stateDir, "verify-report.txt"));
  const outputLog = readTextFileIfExists(join(stateDir, "output.log"));

  const sections = [`claude-realtime job ${basename(stateDir)} status=${status}`];

  if (latestResult?.resultText) {
    const metadata = [
      latestResult.numTurns != null ? `turns=${latestResult.numTurns}` : "",
      latestResult.costUsd != null ? `cost=$${latestResult.costUsd.toFixed(2)}` : "",
    ].filter(Boolean).join(", ");
    sections.push([
      `Latest Claude result${metadata ? ` (${metadata})` : ""}:`,
      tailText(latestResult.resultText, 16, 1600),
    ].join("\n"));
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
): { sessionId?: string; resultText?: string; numTurns?: number; costUsd?: number } | null {
  try {
    if (!existsSync(stateDir)) return null;

    const resultFiles = readdirSync(stateDir)
      .filter((name) => /^result-\d+\.json$/.test(name))
      .sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    if (resultFiles.length === 0) return null;

    const latest = JSON.parse(readFileSync(join(stateDir, resultFiles[resultFiles.length - 1]), "utf-8"));
    return {
      sessionId: typeof latest.session_id === "string" ? latest.session_id : undefined,
      resultText: typeof latest.result === "string" ? latest.result : undefined,
      numTurns: typeof latest.num_turns === "number" ? latest.num_turns : undefined,
      costUsd: typeof latest.total_cost_usd === "number" ? latest.total_cost_usd : undefined,
    };
  } catch {
    return null;
  }
}

function extractRealtimeRound(filename: string): number {
  const match = filename.match(/^result-(\d+)\.json$/);
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

function sanitizeRealtimeFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveRealtimeNotifyAgent(ctx: OpenClawPluginToolContext): string {
  return ctx.agentId
    || ctx.agentAccountId
    || process.env.OPENCLAW_NOTIFY_AGENT_DEFAULT
    || "nova";
}

function resolveRealtimeModel(workerModel: string): "opus" | "sonnet" {
  return workerModel.toLowerCase().includes("opus") ? "opus" : "sonnet";
}

function buildHarnessSubagentSessionKey(
  agentId: string,
  planId: string,
  taskId: string,
  role: "worker" | "reviewer",
): string {
  return role === "reviewer"
    ? `agent:${agentId}:subagent:harness-${planId}-${taskId}-review`
    : `agent:${agentId}:subagent:harness-${planId}-${taskId}`;
}

async function getLatestSubagentAssistantText(
  runtime: any,
  sessionKey: string,
  role: "worker" | "reviewer",
): Promise<string> {
  const msgs = await runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
  console.log(
    `[harness] ${role} getSessionMessages: key=${sessionKey}, count=${msgs?.messages?.length ?? 0}`,
  );
  const rawContent = msgs?.messages?.filter((m: any) => m.role === "assistant")?.pop()?.content ?? "";
  console.log(
    `[harness] ${role} rawContent type=${typeof rawContent}, isArray=${Array.isArray(rawContent)}`,
  );
  return flattenSubagentMessageContent(rawContent);
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
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes max
  const pollIntervalMs = 3000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const session = sessionManager!.get(sessionId);
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
  sessionManager!.kill(sessionId);
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

function extractFilePaths(output: string): string[] {
  const paths: string[] = [];
  const matches = output.match(/(?:^|\s)((?:src|lib|app|pages|components)\/[\w\-./]+\.\w+)/gm);
  if (matches) {
    for (const m of matches) {
      paths.push(m.trim());
    }
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

const RISKY_CONFIG_PATTERNS = [
  /\.env\b/i,
  /\.plist\b/i,
  /credentials/i,
  /secrets?\b/i,
  /\bapi[_-]?key/i,
  /\btoken\b.*\b(수정|변경|update|change|set)\b/i,
  /openclaw\.json/i,
  /package\.json/i,
  /tsconfig/i,
  /config\.ya?ml/i,
  /\.ya?ml\b.*\b(config|설정)/i,
  /\b(settings|configuration)\.ya?ml/i,
  /docker(file|compose)/i,
  /nginx\.conf/i,
  /\.gitignore/i,
];

function isRiskyTier0(request: string): boolean {
  return RISKY_CONFIG_PATTERNS.some((p) => p.test(request));
}

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

function formatPlanForApproval(
  plan: HarnessPlan,
  route: ReturnType<typeof classifyRequest>,
  mode: OperationMode,
): string {
  const lines = [
    `## Harness: Plan Requires Approval`,
    ``,
    `**Tier:** ${route.tier} (${route.confidence})`,
    `**Mode:** ${mode}`,
    `**Plan ID:** ${plan.id}`,
    `**Tasks:** ${plan.tasks.length} (${plan.mode})`,
    ``,
    `### Tasks`,
  ];

  for (const task of plan.tasks) {
    lines.push(
      ``,
      `**${task.id}: ${task.title}**`,
      `- Scope: ${task.scope}`,
      `- Agent: ${task.agent}`,
      `- Acceptance criteria:`,
      ...task.acceptanceCriteria.map((c) => `  - ${c}`),
    );
  }

  lines.push(
    ``,
    `---`,
    `To approve, re-call with \`approved_plan_id: "${plan.id}"\`.`,
    `Or modify the request and re-run.`,
  );
  return lines.join("\n");
}

function formatFinalResult(
  plan: HarnessPlan,
  route: ReturnType<typeof classifyRequest>,
  results: TaskExecutionResult[],
  mode: OperationMode,
  checkpoint: CheckpointData,
  runState: ExecutionRunState,
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
  ];

  if (runState.mode === "resumed") {
    lines.push(
      `**Skipped completed:** ${formatTaskIdList(runState.skippedCompletedTaskIds)}`,
      `**Continued tasks:** ${formatTaskIdList(runState.resumedTaskIds)}`,
    );
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
