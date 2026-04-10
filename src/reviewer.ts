import type { ReviewResult, ReviewGap, TaskSpec, WorkerResult, GapType } from "./types";
import { REVIEWER_SYSTEM_PROMPT, GAP_DEFINITIONS, GAP_MIN_SEVERITY_THRESHOLD } from "./gap-types";

const VALID_GAP_TYPES: GapType[] = [
  "assumption_injection",
  "scope_creep",
  "direction_drift",
  "missing_core",
  "over_engineering",
];

const GAP_TYPE_PATTERNS: Array<{ type: GapType; pattern: RegExp }> = [
  { type: "assumption_injection", pattern: /\bassumption[_\s-]?injection\b/i },
  { type: "scope_creep", pattern: /\bscope[_\s-]?creep\b/i },
  { type: "direction_drift", pattern: /\bdirection[_\s-]?drift\b/i },
  { type: "missing_core", pattern: /\bmissing[_\s-]?core\b/i },
  { type: "over_engineering", pattern: /\bover[_\s-]?engineering\b/i },
];

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
  for (const candidate of extractJsonCandidates(output)) {
    try {
      const parsed = JSON.parse(candidate);
      return validateReviewResult(parsed, taskId);
    } catch {
      // Try the next candidate, then fall back to heuristic parsing.
    }
  }

  const fallback = parseFallbackReviewOutput(output, taskId);
  if (fallback) {
    return fallback;
  }

  console.warn(`[reviewer] Failed to parse review output for ${taskId}, requesting reviewer retry`);
  return {
    taskId,
    result: "fail",
    gaps: [],
    rerunNeeded: true,
    retryReviewer: true,
  };
}

/**
 * Validate and normalize a parsed review result.
 */
function validateReviewResult(parsed: any, taskId: string): ReviewResult {
  const gaps: ReviewGap[] = [];
  if (Array.isArray(parsed.gaps)) {
    for (const gap of parsed.gaps) {
      if (VALID_GAP_TYPES.includes(gap.type) && gap.evidence) {
        gaps.push({
          type: gap.type,
          evidence: String(gap.evidence),
          fixHint: String(gap.fixHint ?? ""),
        });
      }
    }
  }

  const normalizedResult =
    parsed?.result === "fail"
      ? "fail"
      : parsed?.result === "pass"
        ? "pass"
        : undefined;

  if (normalizedResult === "fail" && gaps.length === 0) {
    return {
      taskId: parsed.taskId ?? taskId,
      result: "fail",
      gaps: [],
      rerunNeeded: true,
      retryReviewer: true,
    };
  }

  // Per-gap severity filtering: gaps below threshold are reported but
  // don't trigger a fix loop. e.g. over_engineering (0.3) is soft-filtered.
  const hardGaps = gaps.filter((gap) => {
    const def = GAP_DEFINITIONS[gap.type];
    return def ? def.severity >= GAP_MIN_SEVERITY_THRESHOLD : true;
  });
  const softGaps = gaps.filter((gap) => {
    const def = GAP_DEFINITIONS[gap.type];
    return def ? def.severity < GAP_MIN_SEVERITY_THRESHOLD : false;
  });

  if (softGaps.length > 0) {
    console.log(`[reviewer] Soft-filtered ${softGaps.length} gap(s) below severity threshold: ${softGaps.map((g) => g.type).join(", ")}`);
  }

  // Derive result from HARD gaps only — soft gaps don't trigger failure
  const derivedResult = hardGaps.length > 0 ? "fail" : "pass";

  return {
    taskId: parsed.taskId ?? taskId,
    result: derivedResult,
    gaps, // Report ALL gaps (hard + soft) for transparency
    rerunNeeded: hardGaps.length > 0,
    retryReviewer: false,
  };
}

export { REVIEWER_SYSTEM_PROMPT };

function extractJsonCandidates(output: string): string[] {
  const candidates = new Set<string>();
  const trimmed = output.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (codeBlockMatch?.[1]) {
    candidates.add(codeBlockMatch[1].trim());
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    candidates.add(jsonMatch[0].trim());
  }

  return [...candidates];
}

function parseFallbackReviewOutput(output: string, taskId: string): ReviewResult | null {
  const hasFailMarker =
    /\bresult\b[^a-zA-Z]{0,10}fail\b/i.test(output) ||
    /"fail"/i.test(output) ||
    /\bfail\b/i.test(output);
  const hasPassMarker =
    /\bresult\b[^a-zA-Z]{0,10}pass\b/i.test(output) ||
    /"pass"/i.test(output) ||
    /\bno gaps?\b/i.test(output);

  if (hasFailMarker) {
    const gaps = extractFallbackGaps(output);
    if (gaps.length > 0) {
      return {
        taskId,
        result: "fail",
        gaps,
        rerunNeeded: true,
        retryReviewer: false,
      };
    }
  }

  if (hasPassMarker) {
    return {
      taskId,
      result: "pass",
      gaps: [],
      rerunNeeded: false,
      retryReviewer: false,
    };
  }

  return null;
}

function extractFallbackGaps(output: string): ReviewGap[] {
  const evidence =
    extractField(output, ["evidence", "gap", "issue", "reason"]) ??
    extractInlineFailReason(output) ??
    extractDescriptiveLine(output);
  if (!evidence) {
    return [];
  }

  const fixHint = extractField(output, ["fixHint", "fix hint", "fix", "suggestion", "recommendation"]) ?? "";

  return [{
    type: detectGapType(output) ?? "missing_core",
    evidence,
    fixHint,
  }];
}

function detectGapType(output: string): GapType | null {
  for (const entry of GAP_TYPE_PATTERNS) {
    if (entry.pattern.test(output)) {
      return entry.type;
    }
  }
  return null;
}

function extractField(output: string, fieldNames: string[]): string | null {
  for (const field of fieldNames) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, "i");
    const quotedMatch = output.match(quoted);
    if (quotedMatch?.[1]) {
      return quotedMatch[1].trim();
    }

    const inline = new RegExp(`${escaped}\\s*[:=-]\\s*(.+)`, "i");
    const inlineMatch = output.match(inline);
    if (inlineMatch?.[1]) {
      return sanitizeExtractedText(inlineMatch[1]);
    }
  }

  return null;
}

function extractInlineFailReason(output: string): string | null {
  const match = output.match(/\bfail\b\s*[:\-]\s*(.+)/i);
  return match?.[1] ? sanitizeExtractedText(match[1]) : null;
}

function extractDescriptiveLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"))
    .filter((line) => !/^[\[\]{},"]+$/.test(line))
    .filter((line) => !/^(taskid|result|gaps|rerunneeded)\b/i.test(line))
    .filter((line) => !/^\b(?:pass|fail)\b$/i.test(line));

  for (const line of lines) {
    const cleaned = sanitizeExtractedText(line);
    if (cleaned && cleaned.length > 12) {
      return cleaned;
    }
  }

  return null;
}

function sanitizeExtractedText(text: string): string {
  return text
    .trim()
    .replace(/^["'`\-:\s]+/, "")
    .replace(/["'`,\s]+$/, "");
}
