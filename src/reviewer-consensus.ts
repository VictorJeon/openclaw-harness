import { runReviewerWithCodexCli } from "./reviewer-runner";
import { runReviewerWithOpenRouter } from "./reviewer-openrouter";
import { parseReviewOutput, REVIEWER_SYSTEM_PROMPT } from "./reviewer";
import { pluginConfig } from "./shared";
import type { ReviewResult, TaskSpec, WorkerResult } from "./types";
import { buildReviewRequest } from "./review-loop";
import type { ReviewLoopState } from "./review-loop";

/**
 * Reviewer Consensus: run 2 reviewers in parallel and use majority vote.
 *
 * Primary:   Codex CLI (configured reviewModel, e.g. gpt-5.4)
 * Secondary: fallback model via claude CLI (e.g. gemini, glm, or sonnet)
 *
 * Consensus rules:
 *   - Both pass  → pass
 *   - Both fail  → fail (merge gaps from both)
 *   - Disagree   → fail (conservative: treat disagreement as "needs review")
 *   - One errors → use the other's result (graceful degradation)
 */

export interface ConsensusResult {
  primary: ReviewResult;
  secondary: ReviewResult | null;
  consensus: ReviewResult;
  mode: "both" | "primary-only" | "secondary-only";
}

export async function runReviewerConsensus(options: {
  task: TaskSpec;
  workerResult: WorkerResult;
  originalRequest: string;
  reviewLoopState: ReviewLoopState;
  workdir: string;
  resumeSessionId?: string;
}): Promise<ConsensusResult> {
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const secondaryModel = pluginConfig.consensusReviewerModel;
  const reasoningEffort = pluginConfig.reviewerReasoningEffort;

  const prompt = buildReviewRequest(
    options.task,
    options.workerResult,
    options.originalRequest,
    options.reviewLoopState,
  );

  // Primary reviewer (Codex CLI)
  const primaryPromise = runReviewerWithCodexCli({
    prompt,
    workdir: options.workdir,
    model: reviewModel,
    reasoningEffort,
    resumeSessionId: options.resumeSessionId,
  }).then((run) => ({
    output: run.output,
    sessionId: run.sessionId,
    error: null as string | null,
  })).catch((err: any) => ({
    output: "",
    sessionId: "",
    error: err?.message ?? String(err),
  }));

  // Secondary reviewer via OpenRouter (only if API key + model configured)
  const hasOpenRouter = !!pluginConfig.openRouterApiKey;
  let secondaryPromise: Promise<{ output: string; sessionId: string; error: string | null }> | null = null;

  if (hasOpenRouter && secondaryModel) {
    secondaryPromise = runReviewerWithOpenRouter({
      prompt,
      model: secondaryModel,
    }).then((run) => ({
      output: run.output,
      sessionId: `openrouter-${run.model}`,
      error: run.error ?? null,
    })).catch((err: any) => ({
      output: "",
      sessionId: "",
      error: err?.message ?? String(err),
    }));
  }

  // Run in parallel
  const [primaryRaw, secondaryRaw] = await Promise.all([
    primaryPromise,
    secondaryPromise ?? Promise.resolve(null),
  ]);

  const primaryResult = primaryRaw.error
    ? null
    : parseReviewOutput(primaryRaw.output, options.task.id);
  const secondaryResult = secondaryRaw && !secondaryRaw.error
    ? parseReviewOutput(secondaryRaw.output, options.task.id)
    : null;

  // Consensus logic
  if (primaryResult && secondaryResult) {
    const bothPass = primaryResult.result === "pass" && secondaryResult.result === "pass";
    const bothFail = primaryResult.result === "fail" && secondaryResult.result === "fail";

    if (bothPass) {
      console.log(`[consensus] Both reviewers pass for ${options.task.id}`);
      return { primary: primaryResult, secondary: secondaryResult, consensus: primaryResult, mode: "both" };
    }

    if (bothFail) {
      // Merge gaps from both reviewers (deduplicate by type)
      const mergedGaps = [...primaryResult.gaps];
      for (const gap of secondaryResult.gaps) {
        if (!mergedGaps.some((g) => g.type === gap.type && g.evidence === gap.evidence)) {
          mergedGaps.push(gap);
        }
      }
      const merged: ReviewResult = {
        ...primaryResult,
        gaps: mergedGaps,
      };
      console.log(`[consensus] Both reviewers fail for ${options.task.id}: ${mergedGaps.length} merged gaps`);
      return { primary: primaryResult, secondary: secondaryResult, consensus: merged, mode: "both" };
    }

    // Disagreement → conservative fail (use the one that found gaps)
    const failResult = primaryResult.result === "fail" ? primaryResult : secondaryResult;
    console.log(`[consensus] Reviewer disagreement for ${options.task.id}: primary=${primaryResult.result}, secondary=${secondaryResult.result} → using fail`);
    return { primary: primaryResult, secondary: secondaryResult, consensus: failResult, mode: "both" };
  }

  // Graceful degradation: one reviewer failed
  if (primaryResult) {
    if (secondaryRaw?.error) {
      console.warn(`[consensus] Secondary reviewer failed: ${secondaryRaw.error}`);
    }
    return { primary: primaryResult, secondary: null, consensus: primaryResult, mode: "primary-only" };
  }

  if (secondaryResult) {
    console.warn(`[consensus] Primary reviewer failed: ${primaryRaw.error}`);
    return { primary: secondaryResult, secondary: null, consensus: secondaryResult, mode: "secondary-only" };
  }

  // Both failed — return a retry-needed result
  console.error(`[consensus] Both reviewers failed: primary=${primaryRaw.error}, secondary=${secondaryRaw?.error}`);
  const fallback: ReviewResult = {
    taskId: options.task.id,
    result: "fail",
    gaps: [],
    rerunNeeded: true,
    retryReviewer: true,
  };
  return { primary: fallback, secondary: null, consensus: fallback, mode: "primary-only" };
}
