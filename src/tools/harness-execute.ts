import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig, getPluginRuntime } from "../shared";
import { classifyRequest } from "../router";
import { buildPlan, searchMemory } from "../planner";
import { initCheckpoint, loadCheckpoint, updateTaskStatus, recordSession } from "../checkpoint";
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
      "Execute a coding task through the Plan-Work-Review harness. Automatically classifies complexity, decomposes tasks, dispatches workers, and runs cross-model review. Returns a structured result with gaps detected.",
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
        const taskResults = await executePlan(plan, workdir, maxBudgetUsd, ctx, existingCheckpoint);

        return {
          content: [{
            type: "text",
            text: formatFinalResult(plan, route, taskResults, mode, existingCheckpoint),
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
          text: formatFinalResult(plan, route, taskResults, mode, checkpoint),
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

async function executePlan(
  plan: HarnessPlan,
  workdir: string,
  maxBudgetUsd: number,
  ctx: OpenClawPluginToolContext,
  checkpoint: CheckpointData,
): Promise<TaskExecutionResult[]> {
  const results: TaskExecutionResult[] = [];
  const budgetPerTask = maxBudgetUsd / plan.tasks.length;

  if (plan.mode === "parallel" && plan.tasks.length > 1) {
    // Parallel with concurrency limit based on runtime available slots
    // Reserve half for review/fix phases, recompute before each batch
    const promises: Promise<TaskExecutionResult>[] = [];

    let i = 0;
    while (i < plan.tasks.length) {
      // Wait for at least one slot before spawning
      const hasSlot = await sessionManager!.waitForSlot();
      if (!hasSlot) {
        // Timeout — push remaining as errors
        for (let j = i; j < plan.tasks.length; j++) {
          promises.push(Promise.resolve({
            taskId: plan.tasks[j].id,
            workerSessionId: "",
            workerResult: null,
            reviewPassed: false,
            reviewLoops: 0,
            escalated: true,
            error: "No session slots available (timeout)",
          }));
        }
        break;
      }

      // Compute batch size from current availability (reserve half for review/fix)
      const batchSize = Math.max(1, Math.floor(sessionManager!.availableSlots() / 2));
      const batch = plan.tasks.slice(i, i + batchSize);
      const batchPromises = batch.map((task) =>
        executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint),
      );
      promises.push(...batchPromises);
      i += batch.length;

      // Wait for batch to complete before next batch
      if (i < plan.tasks.length) {
        await Promise.allSettled(batchPromises);
      }
    }

    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          taskId: "unknown",
          workerSessionId: "",
          workerResult: null,
          reviewPassed: false,
          reviewLoops: 0,
          escalated: true,
          error: result.reason?.message ?? String(result.reason),
        });
      }
    }
  } else {
    // Sequential (or solo): execute tasks one by one
    for (const task of plan.tasks) {
      const result = await executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint);
      results.push(result);

      // If a sequential task didn't pass, stop the chain
      if (plan.mode === "sequential" && !result.reviewPassed) {
        break;
      }
    }
  }

  return results;
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

  // Budget: split across phases with a remaining counter
  // Initial worker gets 50%. Remaining 50% covers:
  //   1 initial review + maxLoops * (fix + rereview)
  // When maxLoops=0: only 1 review phase (no fix cycles)
  const maxLoops = Math.max(0, pluginConfig.maxReviewLoops);
  const workerBudget = budgetUsd * 0.5;
  let remainingBudget = budgetUsd * 0.5;
  const totalPhases = maxLoops === 0 ? 1 : 1 + 2 * maxLoops;
  const perPhaseBudget = remainingBudget / totalPhases;

  try {
    const runtime = getPluginRuntime();
    const useSubagent = runtime?.subagent?.run != null;
    const agentId = ctx.agentId ?? "main";

    // --- Worker phase ---
    updateTaskStatus(checkpoint, task.id, "in-progress", workdir);

    const workerPrompt = buildWorkerPrompt(task, plan);
    let workerSessionId = "";
    let workerResult: WorkerResult | null = null;

    if (useSubagent) {
      // === ACP/Subagent path: real cross-model ===
      const workerKey = `agent:${agentId}:subagent:harness-${plan.id}-${task.id}`;
      const workerIdempotencyKey = `harness-worker-${plan.id}-${task.id}-${Date.now()}`;
      const workerRunParams = {
        idempotencyKey: workerIdempotencyKey,
        sessionKey: workerKey,
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
      workerSessionId = workerKey;
      console.log(`[harness] Worker subagent.run returned runId=${runId}`);
      const completion = await runtime.subagent.waitForRun({ runId, timeoutMs: 600000 });
      console.log(`[harness] Worker waitForRun result: status=${completion?.status}, error=${completion?.error}`);
      if (completion?.status === "error") {
        throw new Error(`Worker subagent failed: ${completion.error ?? "unknown"}`);
      }
      // Extract result from subagent messages
      const msgs = await runtime.subagent.getSessionMessages({ sessionKey: workerKey, limit: 5 });
      console.log(`[harness] Worker getSessionMessages: count=${msgs?.messages?.length ?? 0}`);
      const assistantMsgs = msgs?.messages?.filter((m: any) => m.role === "assistant") ?? [];
      const lastAssistant = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : null;
      const rawContent = lastAssistant?.content ?? "";
      console.log(`[harness] Worker rawContent type=${typeof rawContent}, isArray=${Array.isArray(rawContent)}`);
      const lastMsg = typeof rawContent === "string" ? rawContent : Array.isArray(rawContent) ? rawContent.map((c: any) => typeof c === "string" ? c : c?.text ?? c?.content ?? "").join("\n") : String(rawContent);
      workerResult = parseWorkerOutput(lastMsg, task.id);
      // Cleanup
      try { await runtime.subagent.deleteSession({ sessionKey: workerKey }); } catch {}
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
    console.log(`[harness] Worker done: task=${task.id}, session=${workerSessionId}, model=${workerModel}, useSubagent=${useSubagent}`);

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
          // === Reviewer via subagent.run — cross-model (Codex/GPT) ===
          const reviewKey = `agent:${agentId}:subagent:harness-${plan.id}-${task.id}-review-${reviewLoop.history.length + 1}`;
          console.log(`[harness] Reviewer via subagent.run: key=${reviewKey}, model=${reviewModel}`);
          const { runId: reviewRunId } = await runtime.subagent.run({
            idempotencyKey: `harness-review-${plan.id}-${task.id}-${reviewLoop.history.length + 1}-${Date.now()}`,
            sessionKey: reviewKey,
            message: REVIEWER_SYSTEM_PROMPT + "\n\n---\n\n" + reviewPrompt,
            provider: reviewModel === "codex" ? "openai-codex" : "anthropic",
            model: reviewModel === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
            deliver: false,
          });
          recordSession(checkpoint, task.id, "reviewer", reviewKey, workdir);
          await runtime.subagent.waitForRun({ runId: reviewRunId, timeoutMs: 300000 });
          const reviewMsgs = await runtime.subagent.getSessionMessages({ sessionKey: reviewKey, limit: 5 });
          const rawReviewContent = reviewMsgs?.messages?.filter((m: any) => m.role === "assistant")?.pop()?.content ?? "";
          reviewOutput = typeof rawReviewContent === "string" ? rawReviewContent : Array.isArray(rawReviewContent) ? rawReviewContent.map((c: any) => c.text ?? c.content ?? "").join("\n") : String(rawReviewContent);
          try { await runtime.subagent.deleteSession({ sessionKey: reviewKey }); } catch {}
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
        const fixBudget = Math.min(perPhaseBudget, remainingBudget);
        remainingBudget -= fixBudget;

        if (useSubagent) {
          // === Fixer via subagent.run — same model as Worker (Claude) ===
          const fixKey = `agent:${agentId}:subagent:harness-${plan.id}-${task.id}-fix-${reviewLoop.currentLoop}`;
          console.log(`[harness] Fixer via subagent.run: key=${fixKey}, model=${workerModel}`);
          const { runId: fixRunId } = await runtime.subagent.run({
            idempotencyKey: `harness-fix-${plan.id}-${task.id}-${reviewLoop.currentLoop}-${Date.now()}`,
            sessionKey: fixKey,
            message: `## Working Directory\nAll file operations MUST use absolute paths under: ${workdir}\nCreate the directory first if it doesn't exist: mkdir -p ${workdir}\n\n${action.fixPrompt}`,
            provider: workerModel === "codex" ? "openai-codex" : "anthropic",
            model: workerModel === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
            deliver: false,
          });
          await runtime.subagent.waitForRun({ runId: fixRunId, timeoutMs: 600000 });
          const fixMsgs = await runtime.subagent.getSessionMessages({ sessionKey: fixKey, limit: 5 });
          const rawFixContent = fixMsgs?.messages?.filter((m: any) => m.role === "assistant")?.pop()?.content ?? "";
          const fixText = typeof rawFixContent === "string" ? rawFixContent : Array.isArray(rawFixContent) ? rawFixContent.map((c: any) => c.text ?? c.content ?? "").join("\n") : String(rawFixContent);
          const fixResult = parseWorkerOutput(fixText, task.id);
          if (fixResult) {
            currentWorkerResult = fixResult;
          }
          try { await runtime.subagent.deleteSession({ sessionKey: fixKey }); } catch {}
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
      workerSessionId: "",
      workerResult: null,
      reviewPassed: false,
      reviewLoops: 0,
      escalated: true,
      error: `${err.message}\n${err.stack ?? ""}`,
    };
  }
}

// --- Session completion helpers ---

interface SessionCompletion {
  status: "completed" | "failed" | "killed" | "timeout";
  output: string;
  error?: string;
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
    `**Result:** ${passed}/${results.length} passed | ${totalLoops} review loops`,
    `**Checkpoint:** ${checkpoint.runId}`,
    ``,
    `### Task Results`,
  ];

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
