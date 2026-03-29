import type {
  TaskSpec,
  WorkerResult,
  ReviewResult,
  ReviewGap,
  HarnessPlan,
} from "./types";
import { pluginConfig } from "./shared";
import { buildReviewPrompt, parseReviewOutput, REVIEWER_SYSTEM_PROMPT } from "./reviewer";

/**
 * Review Loop: Orchestrates the review-fix-rereview cycle.
 *
 * Architecture (cross-model session ping-pong):
 *   ACP Claude session (1, maintained): implementation + fixes
 *   ACP Codex session (1, maintained): review + re-review
 *
 *   1. Worker (Claude) implements → result
 *   2. Reviewer (Codex) reviews → gaps found?
 *      - No gaps → pass, done
 *      - Gaps → send fix instructions to Worker via sessions_send
 *   3. Worker fixes → updated result
 *   4. Reviewer re-reviews (same Codex session, remembers previous gaps)
 *   ... up to maxReviewLoops (default 4)
 *
 * Key: same model builds and reviews = shared blind spots.
 *      Different models cross-check each other.
 */

export interface ReviewLoopState {
  taskId: string;
  currentLoop: number;
  maxLoops: number;
  gaps: ReviewGap[];
  passed: boolean;
  escalated: boolean;
  history: ReviewResult[];
}

/**
 * Initialize review loop state for a task.
 */
export function initReviewLoop(taskId: string): ReviewLoopState {
  return {
    taskId,
    currentLoop: 0,
    maxLoops: pluginConfig.maxReviewLoops,
    gaps: [],
    passed: false,
    escalated: false,
    history: [],
  };
}

/**
 * Process a review result and determine next action.
 */
/**
 * Process a review result and determine next action.
 *
 * Loop counting: currentLoop tracks fix attempts (not reviews).
 * - Initial review: doesn't count as a fix attempt
 * - Each subsequent review after a fix: increments currentLoop
 * - Escalate when fix attempts >= maxLoops
 *
 * With maxLoops=4: initial impl + review, then up to 4 fix+rereview cycles.
 */
export function processReviewResult(
  state: ReviewLoopState,
  reviewResult: ReviewResult,
): ReviewLoopAction {
  state.history.push(reviewResult);
  state.gaps = reviewResult.gaps;

  if (reviewResult.result === "pass") {
    state.passed = true;
    return { action: "pass", state };
  }

  // Only count as a fix attempt if this is a re-review (not the initial review)
  if (state.history.length > 1) {
    state.currentLoop++;
  }

  if (state.currentLoop >= state.maxLoops) {
    state.escalated = true;
    return { action: "escalate", state, reason: `Max fix attempts (${state.maxLoops}) exceeded` };
  }

  return {
    action: "fix",
    state,
    fixPrompt: buildFixPrompt(reviewResult, state.currentLoop + 1),
  };
}

export type ReviewLoopAction =
  | { action: "pass"; state: ReviewLoopState }
  | { action: "fix"; state: ReviewLoopState; fixPrompt: string }
  | { action: "escalate"; state: ReviewLoopState; reason: string };

/**
 * Build a fix prompt to send to the Worker (Claude) session.
 */
function buildFixPrompt(review: ReviewResult, loopNumber: number): string {
  const lines = [
    `## Review Feedback (Loop ${loopNumber})`,
    ``,
    `The reviewer found ${review.gaps.length} gap(s). Fix them:`,
    ``,
  ];

  for (const gap of review.gaps) {
    lines.push(`### ${gap.type}`);
    lines.push(`**Evidence:** ${gap.evidence}`);
    if (gap.fixHint) {
      lines.push(`**Fix hint:** ${gap.fixHint}`);
    }
    lines.push(``);
  }

  lines.push(
    `## Rules`,
    `- Fix ONLY the reported gaps. Do not make other changes.`,
    `- When done, summarize what you fixed.`,
  );

  return lines.join("\n");
}

/**
 * Build the review request prompt for the Reviewer (Codex) session.
 * Includes previous gaps for continuity in re-reviews.
 */
export function buildReviewRequest(
  task: TaskSpec,
  workerResult: WorkerResult,
  originalRequest: string,
  state: ReviewLoopState,
): string {
  const previousGaps = state.currentLoop > 0 ? state.gaps : undefined;
  return buildReviewPrompt(task, workerResult, originalRequest, previousGaps);
}

/**
 * Format escalation message for Mason.
 */
export function formatEscalation(
  plan: HarnessPlan,
  state: ReviewLoopState,
  task: TaskSpec,
): string {
  const lines = [
    `## Harness Escalation`,
    ``,
    `Task **${task.id}: ${task.title}** failed to pass review after ${state.maxLoops} loops.`,
    ``,
    `**Plan:** ${plan.id}`,
    `**Original request:** ${plan.originalRequest}`,
    ``,
    `### Remaining Gaps`,
  ];

  for (const gap of state.gaps) {
    lines.push(`- **${gap.type}:** ${gap.evidence}`);
    if (gap.fixHint) lines.push(`  Fix: ${gap.fixHint}`);
  }

  lines.push(
    ``,
    `### Review History`,
    `${state.history.length} review(s) performed. Gap counts: ${state.history.map((r, i) => `loop ${i + 1}: ${r.gaps.length}`).join(", ")}`,
    ``,
    `Manual intervention needed.`,
  );

  return lines.join("\n");
}
