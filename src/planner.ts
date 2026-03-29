import type { HarnessPlan, TaskSpec, Tier } from "./types";
import { pluginConfig } from "./shared";

/**
 * Planner: decompose a request into concrete tasks with acceptance criteria.
 *
 * Before decomposition, optionally queries Memory V3 for context
 * (previous implementations, decisions, lessons learned).
 *
 * Output: HarnessPlan with tasks, mode (solo/parallel/sequential),
 * and estimated complexity.
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
 * Query Memory V3 for relevant context before planning.
 * Returns memory search results or empty string if unavailable.
 */
export async function searchMemory(projectName: string): Promise<string> {
  const endpoint = pluginConfig.memoryV3Endpoint;
  if (!endpoint) return "";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `${projectName} 현재 상태` }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return "";
  }
}

/**
 * Generate a plan by sending the request to an LLM for task decomposition.
 * For tier 1 (simple tasks), creates a single-task plan.
 * For tier 2 (complex tasks), decomposes into multiple tasks.
 */
export function buildPlan(
  request: string,
  tier: Tier,
  memoryContext: string = "",
): HarnessPlan {
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

/**
 * Generate the LLM prompt for task decomposition (tier 2).
 * This prompt is sent to ACP Claude for planning.
 */
export function buildPlannerPrompt(request: string, memoryContext: string): string {
  const parts = [
    `You are a task planner. Decompose this request into concrete, independent tasks.`,
    ``,
    `## Request`,
    request,
  ];

  if (memoryContext) {
    parts.push(``, `## Memory Context (previous work)`, memoryContext);
  }

  parts.push(
    ``,
    `## Output Format (YAML)`,
    `tasks:`,
    `  - id: task-1`,
    `    title: "<short title>"`,
    `    scope: "<specific files/functions to modify>"`,
    `    acceptance_criteria:`,
    `      - "<concrete, testable criterion>"`,
    `    agent: codex`,
    `  - id: task-2`,
    `    ...`,
    `mode: parallel | sequential | solo`,
    `estimated_complexity: low | medium | high`,
    ``,
    `## Rules`,
    `- Each task must be independently executable`,
    `- Scope must be specific (file paths, function names)`,
    `- Acceptance criteria must be testable`,
    `- Use "codex" as default agent`,
    `- Use "parallel" when tasks don't share files`,
    `- Use "sequential" when later tasks depend on earlier ones`,
    `- Maximum 6 tasks per plan`,
  );

  return parts.join("\n");
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
    for (let i = 0; i < numbered.length; i++) {
      const text = numbered[i].replace(/^\d+[.)]\s+/, "").trim();
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
    for (let i = 0; i < bulletMatches.length; i++) {
      const text = bulletMatches[i].replace(/^\s*[-•*]\s+/, "").trim();
      if (text.length < 5) continue;
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

  // Single complex task
  tasks.push({
    id: nextTaskId(0),
    title: extractTitle(request),
    scope: request,
    acceptanceCriteria: extractAcceptanceCriteria(request),
    agent: "codex",
  });

  return tasks;
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
  // mention the same file, they must run sequentially
  const filesByTask = tasks.map((t) => extractScopeFiles(t.scope));
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
