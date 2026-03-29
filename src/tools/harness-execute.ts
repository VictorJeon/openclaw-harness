import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig } from "../shared";
import { classifyRequest } from "../router";
import { buildPlan, searchMemory } from "../planner";
import { initCheckpoint, updateTaskStatus, recordSession } from "../checkpoint";
import { initReviewLoop, processReviewResult, formatEscalation, buildReviewRequest } from "../review-loop";
import { parseReviewOutput, REVIEWER_SYSTEM_PROMPT } from "../reviewer";
import type {
  OpenClawPluginToolContext,
  HarnessPlan,
  OperationMode,
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
      // Ask mode: require approval for everything except safe tier 0
      // Delegate mode: require approval for risky ops (tier 2 or risky config)
      const isRiskyConfig = tier === 0 && isRiskyTier0(params.request);

      if (mode === "ask" && (tier > 0 || isRiskyConfig)) {
        const plan = buildPlan(params.request, tier > 0 ? tier : 1);
        return {
          content: [{
            type: "text",
            text: formatPlanForApproval(plan, route, mode),
          }],
        };
      }

      if (isRiskyConfig && mode !== "autonomous") {
        return {
          content: [{
            type: "text",
            text: [
              `## Harness: Risky Config Change — Approval Required`,
              ``,
              `This request modifies sensitive config files (.env, plist, etc.).`,
              `Even in Delegate mode, config changes require explicit approval.`,
              ``,
              `**Request:** ${params.request}`,
              `**Workdir:** ${workdir}`,
              ``,
              `Approve to proceed, or modify the request.`,
            ].join("\n"),
          }],
        };
      }

      // Tier 0: direct execution by the OpenClaw agent (no worker needed)
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

      // Delegate mode + tier 2: show plan for confirmation
      if (mode === "delegate" && tier === 2) {
        const plan = buildPlan(params.request, tier);
        return {
          content: [{
            type: "text",
            text: formatPlanForApproval(plan, route, mode),
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
    // Parallel: spawn all workers, then review each
    const promises = plan.tasks.map((task) =>
      executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint),
    );
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
  // Determine model based on task.agent field
  const workerModel = task.agent === "codex"
    ? (pluginConfig.workerModel || pluginConfig.defaultModel)
    : (pluginConfig.defaultModel || pluginConfig.workerModel);

  // Budget: split across phases with a remaining counter
  // Initial worker gets 50%, rest is shared among review/fix cycles
  const maxLoops = pluginConfig.maxReviewLoops;
  const workerBudget = budgetUsd * 0.5;
  const reviewFixBudget = budgetUsd * 0.5;
  const perCycleBudget = reviewFixBudget / Math.max(maxLoops, 1);
  let remainingBudget = reviewFixBudget;

  try {
    // --- Worker phase: single-turn session ---
    updateTaskStatus(checkpoint, task.id, "in-progress", workdir);

    const workerPrompt = buildWorkerPrompt(task, plan);
    const workerSession = sessionManager!.spawn({
      prompt: workerPrompt,
      name: `harness-${plan.id}-${task.id}`,
      workdir,
      model: workerModel,
      maxBudgetUsd: workerBudget,
      permissionMode: pluginConfig.permissionMode ?? "bypassPermissions",
      originChannel: ctx.messageChannel,
      originAgentId: ctx.agentId,
      multiTurn: false, // Single-turn: completes when done
    });

    recordSession(checkpoint, task.id, "worker", workerSession.id, workdir);
    console.log(`[harness] Worker spawned: task=${task.id}, session=${workerSession.id}, model=${workerModel}`);

    // Wait for worker to complete
    const workerResult = await waitForCompletion(workerSession.id, task.id);

    if (!workerResult) {
      updateTaskStatus(checkpoint, task.id, "failed", workdir);
      return {
        taskId: task.id,
        workerSessionId: workerSession.id,
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
    const reviewModel = pluginConfig.reviewModel || pluginConfig.defaultModel;
    let currentWorkerResult = workerResult;

    while (!reviewLoop.passed && !reviewLoop.escalated) {
      // Spawn reviewer (single-turn, cross-model)
      const reviewPrompt = buildReviewRequest(task, currentWorkerResult, plan.originalRequest, reviewLoop);
      const reviewerSession = sessionManager!.spawn({
        prompt: reviewPrompt,
        name: `harness-${plan.id}-${task.id}-review-${reviewLoop.history.length + 1}`,
        workdir,
        model: reviewModel,
        maxBudgetUsd: Math.min(perCycleBudget * 0.4, remainingBudget * 0.4), // review portion of cycle
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        permissionMode: "default", // Restrictive: no bypass
        allowedTools: ["Read", "Glob", "Grep", "LS"], // Read-only tools only
        originChannel: ctx.messageChannel,
        originAgentId: ctx.agentId,
        multiTurn: false,
      });

      recordSession(checkpoint, task.id, "reviewer", reviewerSession.id, workdir);
      console.log(`[harness] Reviewer spawned: task=${task.id}, session=${reviewerSession.id}, loop=${reviewLoop.history.length + 1}`);

      // Wait for reviewer to complete
      const reviewOutput = await waitForOutput(reviewerSession.id);
      const reviewResult = parseReviewOutput(reviewOutput, task.id);

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
          workerSessionId: workerSession.id,
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
          workerSessionId: workerSession.id,
          workerResult: currentWorkerResult,
          reviewPassed: false,
          reviewLoops: reviewLoop.history.length,
          escalated: true,
          escalationReason: formatEscalation(plan, reviewLoop, task),
        };
      }

      // action === "fix": spawn a fixer session with gap feedback
      if (action.action === "fix") {
        const fixBudget = Math.min(perCycleBudget * 0.6, remainingBudget * 0.6);
        remainingBudget -= perCycleBudget;

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

        console.log(`[harness] Fixer spawned: task=${task.id}, session=${fixSession.id}, loop=${reviewLoop.currentLoop}`);

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
      workerSessionId: workerSession.id,
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
      error: err.message,
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

  lines.push(``, `---`, `Approve this plan to proceed, or modify the request and re-run.`);
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
