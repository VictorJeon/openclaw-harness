import type { ReviewResult, ReviewGap, TaskSpec, WorkerResult, GapType } from "./types";
import { REVIEWER_SYSTEM_PROMPT } from "./gap-types";

/**
 * Reviewer: Analyze worker output against task spec and acceptance criteria.
 *
 * Uses ACP Codex for cross-model review (different model = different blind spots).
 * Reviewer is READ-ONLY — it never modifies code, only reports gaps.
 *
 * The review prompt includes:
 *   - Original task spec + acceptance criteria
 *   - Worker's result summary + files changed
 *   - The 5-type gap taxonomy for structured output
 */

/**
 * Build the review prompt for ACP Codex session.
 */
export function buildReviewPrompt(
  task: TaskSpec,
  workerResult: WorkerResult,
  originalRequest: string,
  previousGaps?: ReviewGap[],
): string {
  const lines = [
    `## Review Task`,
    ``,
    `**Original request:** ${originalRequest}`,
    ``,
    `### Task Specification`,
    `- **ID:** ${task.id}`,
    `- **Title:** ${task.title}`,
    `- **Scope:** ${task.scope}`,
    `- **Acceptance criteria:**`,
    ...task.acceptanceCriteria.map((c) => `  - ${c}`),
    ``,
    `### Worker Result`,
    `- **Status:** ${workerResult.status}`,
    `- **Summary:** ${workerResult.summary}`,
    `- **Files changed:**`,
    ...workerResult.filesChanged.map((f) => `  - ${f}`),
    `- **Tests run:** ${workerResult.testsRun}`,
  ];

  if (workerResult.warnings.length > 0) {
    lines.push(`- **Warnings:**`);
    for (const w of workerResult.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  if (previousGaps && previousGaps.length > 0) {
    lines.push(
      ``,
      `### Previous Gaps (from last review — verify these are fixed)`,
    );
    for (const gap of previousGaps) {
      lines.push(`- **${gap.type}:** ${gap.evidence}`);
      lines.push(`  Fix hint: ${gap.fixHint}`);
    }
    lines.push(
      ``,
      `**IMPORTANT:** Verify that the previous gaps have been addressed. If they persist, report them again.`,
    );
  }

  lines.push(
    ``,
    `### Instructions`,
    `Review the changed files against the acceptance criteria. Output JSON as specified in system prompt.`,
    `Read each changed file and check if the acceptance criteria are met.`,
  );

  return lines.join("\n");
}

/**
 * Parse reviewer output into structured ReviewResult.
 * Handles both clean JSON and JSON embedded in markdown code blocks.
 */
export function parseReviewOutput(output: string, taskId: string): ReviewResult {
  // Try to extract JSON from the output
  let jsonStr = output.trim();

  // Handle markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the output
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return validateReviewResult(parsed, taskId);
  } catch {
    // Parse failure = fail-closed (don't silently pass broken reviews)
    console.warn(`[reviewer] Failed to parse review output for ${taskId}, treating as fail`);
    return {
      taskId,
      result: "fail",
      gaps: [{
        type: "missing_core",
        evidence: "Reviewer output was malformed and could not be parsed",
        fixHint: "Re-run review with structured output",
      }],
      rerunNeeded: true,
    };
  }
}

/**
 * Validate and normalize a parsed review result.
 */
function validateReviewResult(parsed: any, taskId: string): ReviewResult {
  const validGapTypes: GapType[] = [
    "assumption_injection",
    "scope_creep",
    "direction_drift",
    "missing_core",
    "over_engineering",
  ];

  const gaps: ReviewGap[] = [];
  if (Array.isArray(parsed.gaps)) {
    for (const gap of parsed.gaps) {
      if (validGapTypes.includes(gap.type) && gap.evidence) {
        gaps.push({
          type: gap.type,
          evidence: String(gap.evidence),
          fixHint: String(gap.fixHint ?? ""),
        });
      }
    }
  }

  // Derive result from gaps, not from parsed.result — prevents
  // reviewer claiming "pass" while reporting gaps
  const derivedResult = gaps.length > 0 ? "fail" : "pass";

  return {
    taskId: parsed.taskId ?? taskId,
    result: derivedResult,
    gaps,
    rerunNeeded: gaps.length > 0,
  };
}

export { REVIEWER_SYSTEM_PROMPT };
