import { runReviewerWithCodexCli } from "./reviewer-runner";
import { pluginConfig } from "./shared";
import type { ReviewResult, ReviewGap, TaskSpec, HarnessPlan } from "./types";
import type { ReviewLoopState } from "./review-loop";

/**
 * Meta-reviewer: one final mediation attempt before escalating to Mason.
 *
 * When the fix loop is exhausted (maxReviewLoops reached), the meta-reviewer
 * gets a synthesis of all review history and makes one of three verdicts:
 *
 *   approve  → force pass (gaps are acceptable / false positives)
 *   revise   → one bonus fix round (meta-reviewer provides consolidated fix instructions)
 *   reject   → escalate to Mason (genuinely stuck)
 *
 * This reduces escalation noise by ~50% (based on the friend's production data).
 */

export type MetaVerdict = "approve" | "revise" | "reject";

export interface MetaReviewResult {
  verdict: MetaVerdict;
  reasoning: string;
  consolidatedFixPrompt?: string;
}

export async function runMetaReview(options: {
  task: TaskSpec;
  plan: HarnessPlan;
  reviewLoopState: ReviewLoopState;
  workdir: string;
}): Promise<MetaReviewResult> {
  const metaModel = pluginConfig.reviewModel ?? "codex"; // same model as primary reviewer
  const reasoningEffort = pluginConfig.reviewerReasoningEffort;

  const prompt = buildMetaReviewPrompt(options);

  try {
    const run = await runReviewerWithCodexCli({
      prompt,
      workdir: options.workdir,
      model: metaModel,
      reasoningEffort,
      timeoutMs: 120_000,
    });

    return parseMetaReviewOutput(run.output);
  } catch (err: any) {
    console.warn(`[meta-reviewer] Failed: ${err?.message ?? String(err)} — defaulting to reject`);
    return {
      verdict: "reject",
      reasoning: `Meta-review failed: ${err?.message ?? String(err)}`,
    };
  }
}

function buildMetaReviewPrompt(options: {
  task: TaskSpec;
  plan: HarnessPlan;
  reviewLoopState: ReviewLoopState;
}): string {
  const { task, plan, reviewLoopState } = options;

  const reviewHistory = reviewLoopState.history.map((review, i) => {
    const gapSummary = review.gaps.length > 0
      ? review.gaps.map((g) => `  - ${g.type}: ${g.evidence}`).join("\n")
      : "  (no gaps)";
    return `Round ${i + 1}: ${review.result}\n${gapSummary}`;
  }).join("\n\n");

  return [
    `You are a meta-reviewer mediating between a code worker and a reviewer that cannot agree.`,
    `The review loop has been exhausted (${reviewLoopState.maxLoops} rounds).`,
    ``,
    `## Task`,
    `**Title:** ${task.title}`,
    `**Scope:** ${task.scope}`,
    `**Original request:** ${plan.originalRequest.slice(0, 1000)}`,
    ``,
    `## Acceptance Criteria`,
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `## Review History`,
    reviewHistory,
    ``,
    `## Your Decision`,
    `Respond with EXACTLY one JSON object:`,
    ``,
    `{`,
    `  "verdict": "approve" | "revise" | "reject",`,
    `  "reasoning": "1-2 sentence explanation",`,
    `  "consolidatedFixPrompt": "if verdict=revise, concrete fix instructions (200+ chars)"`,
    `}`,
    ``,
    `Decision guide:`,
    `- "approve": remaining gaps are false positives or acceptable trade-offs. Force pass.`,
    `- "revise": there's a clear fix that hasn't been tried. Give one more chance with specific instructions.`,
    `- "reject": genuinely stuck — escalate to human supervisor.`,
  ].join("\n");
}

function parseMetaReviewOutput(output: string): MetaReviewResult {
  // Try JSON extraction
  const jsonMatch = output.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const verdict = parsed.verdict === "approve" ? "approve"
        : parsed.verdict === "revise" ? "revise"
        : "reject";

      return {
        verdict,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 500) : "meta-review parsed",
        consolidatedFixPrompt: verdict === "revise" && typeof parsed.consolidatedFixPrompt === "string"
          ? parsed.consolidatedFixPrompt
          : undefined,
      };
    } catch {
      // fall through to heuristic
    }
  }

  // Heuristic: look for keywords
  const lower = output.toLowerCase();
  if (/\bapprove\b/.test(lower)) {
    return { verdict: "approve", reasoning: "Heuristic: 'approve' keyword detected" };
  }
  if (/\brevise\b/.test(lower)) {
    return {
      verdict: "revise",
      reasoning: "Heuristic: 'revise' keyword detected",
      consolidatedFixPrompt: output.slice(0, 1000),
    };
  }

  return { verdict: "reject", reasoning: "Could not parse meta-review output" };
}
