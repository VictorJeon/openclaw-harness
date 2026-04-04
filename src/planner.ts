import type { HarnessPlan, TaskSpec, Tier } from "./types";

/**
 * Deterministic planner: decompose a request into concrete tasks with
 * acceptance criteria.
 *
 * No model call happens here. The planner is intentionally heuristic-only so
 * routing/planning stays cheap, predictable, and independent of worker model
 * selection.
 */

function nextPlanId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `plan-${date}-${rand}`;
}

function nextTaskId(index: number): string {
  return `task-${index + 1}`;
}

/**
 * Generate a plan deterministically.
 * Tier 1 stays single-task. Tier 2 may decompose into multiple tasks.
 */
export function buildPlan(request: string, tier: Tier): HarnessPlan {
  if (tier === 0) {
    // Tier 0: direct execution, no plan needed
    return {
      id: nextPlanId(),
      originalRequest: request,
      tasks: [{
        id: nextTaskId(0),
        title: "Direct execution",
        scope: request,
        acceptanceCriteria: ["Request fulfilled as specified"],
        agent: "claude",
      }],
      mode: "solo",
      estimatedComplexity: "low",
      tier: 0,
    };
  }

  if (tier === 1) {
    // Tier 1: single worker task
    return {
      id: nextPlanId(),
      originalRequest: request,
      tasks: [{
        id: nextTaskId(0),
        title: extractTitle(request),
        scope: request,
        acceptanceCriteria: extractAcceptanceCriteria(request),
        agent: "codex",
      }],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 1,
    };
  }

  // Tier 2: decompose into multiple tasks
  const tasks = decomposeTasks(request);
  const mode = tasks.length === 1 ? "solo" : canParallelize(tasks) ? "parallel" : "sequential";

  return {
    id: nextPlanId(),
    originalRequest: request,
    tasks,
    mode,
    estimatedComplexity: "high",
    tier: 2,
  };
}

// --- Helper functions ---

function extractTitle(request: string): string {
  // Take first sentence or first 60 chars
  const firstSentence = request.split(/[.!?\n]/)[0]?.trim() ?? request;
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + "...";
}

function extractAcceptanceCriteria(request: string): string[] {
  const criteria: string[] = [];

  // Look for explicit requirements
  const lines = request.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-•*]\s+/.test(trimmed)) {
      criteria.push(trimmed.replace(/^[-•*]\s+/, ""));
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      criteria.push(trimmed.replace(/^\d+[.)]\s+/, ""));
    }
  }

  if (criteria.length === 0) {
    criteria.push("Implementation matches the request specification");
    criteria.push("No regressions in existing functionality");
  }

  return criteria;
}

function decomposeTasks(request: string): TaskSpec[] {
  const tasks: TaskSpec[] = [];

  // Try to split by numbered items
  const numbered = request.match(/\d+[.)]\s+[^\n]+/g);
  if (numbered && numbered.length >= 2) {
    const numberedItems = numbered.map((item) => item.replace(/^\d+[.)]\s+/, "").trim());
    if (shouldCollapseIntoSingleTask(request, numberedItems)) {
      return [buildSingleTask(request)];
    }
    for (let i = 0; i < numberedItems.length; i++) {
      const text = numberedItems[i];
      tasks.push({
        id: nextTaskId(i),
        title: extractTitle(text),
        scope: text,
        acceptanceCriteria: [text],
        agent: "codex",
      });
    }
    return tasks;
  }

  // Try to split by bullet points — extract only the bullet lines, skip preamble
  const bulletMatches = request.match(/(?:^|\n)\s*[-•*]\s+[^\n]+/g);
  if (bulletMatches && bulletMatches.length >= 2) {
    const bulletItems = bulletMatches
      .map((item) => item.replace(/^\s*[-•*]\s+/, "").trim())
      .filter((text) => text.length >= 5);
    if (shouldCollapseIntoSingleTask(request, bulletItems)) {
      return [buildSingleTask(request)];
    }
    for (const text of bulletItems) {
      tasks.push({
        id: nextTaskId(tasks.length),
        title: extractTitle(text),
        scope: text,
        acceptanceCriteria: [text],
        agent: "codex",
      });
    }
    if (tasks.length >= 2) return tasks;
    tasks.length = 0; // reset if only 1 valid bullet
  }

  return [buildSingleTask(request)];
}

function buildSingleTask(request: string): TaskSpec {
  return {
    id: nextTaskId(0),
    title: extractTitle(request),
    scope: request,
    acceptanceCriteria: extractAcceptanceCriteria(request),
    agent: "codex",
  };
}

function shouldCollapseIntoSingleTask(request: string, candidateItems: string[]): boolean {
  if (candidateItems.length === 0 || candidateItems.length > 5) {
    return false;
  }

  const combined = [request, ...candidateItems].join("\n");
  if (/(migration|migrate|rewrite|architecture|system|integration|infra|large scale|마이그레이션|재작성|아키텍처|시스템|통합|인프라|대규모)/i.test(combined)) {
    return false;
  }

  const explicitFiles = extractScopeFiles(combined);
  if (explicitFiles.length > 3) {
    return false;
  }

  const workflowishItems = candidateItems.filter(isSingleFeatureWorkflowItem);
  const hasSupportingWorkflow = workflowishItems.length >= Math.max(1, candidateItems.length - 1);
  const hasVerification = /(pytest|test|verify|validation|검증|테스트)/i.test(combined);
  const hasDocs = /(readme|usage|example|문서|예시)/i.test(combined);
  const hasCommit = /(\bcommit\b|커밋)/i.test(combined);
  const hasMinimalitySignal = /(minimal|simple|keep it minimal|readable|간단|최소|작게)/i.test(combined);

  return hasSupportingWorkflow && (hasVerification || hasDocs || hasCommit || hasMinimalitySignal);
}

function isSingleFeatureWorkflowItem(text: string): boolean {
  return /^(?:create|add|update|modify|implement|write|run|verify|commit)\b|^(?:생성|추가|수정|구현|작성|실행|검증|커밋)\b|\b(readme|pytest|test|commit|usage|example|verify|validation)\b|\b(문서|테스트|검증|예시|커밋)\b/i.test(text);
}

function canParallelize(tasks: TaskSpec[]): boolean {
  if (tasks.length <= 1) return false;

  // Check for explicit dependencies
  for (const task of tasks) {
    if (/\b(after|then|다음에|이후에|완료\s*후)\b/i.test(task.scope)) {
      return false;
    }
  }

  // Check for overlapping file paths in scopes — if any two tasks
  // mention the same file, they must run sequentially.
  // If any scope has NO explicit files, default to sequential (fail-safe).
  const filesByTask = tasks.map((t) => extractScopeFiles(t.scope));

  for (const files of filesByTask) {
    if (files.length === 0) {
      // Can't verify disjointness without explicit file paths → sequential
      return false;
    }
  }

  for (let i = 0; i < filesByTask.length; i++) {
    for (let j = i + 1; j < filesByTask.length; j++) {
      const overlap = filesByTask[i].filter((f) => filesByTask[j].includes(f));
      if (overlap.length > 0) {
        return false;
      }
    }
  }

  return true;
}

function extractScopeFiles(scope: string): string[] {
  const matches = scope.match(/[\w\-./]+\.\w{1,5}/g);
  return matches ? [...new Set(matches)] : [];
}
