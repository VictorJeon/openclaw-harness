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

const REPORT_SECTION_HEADERS = [
  /^return\s*:?$/i,
  /^output\s*:?$/i,
  /^deliverables?\s*:?$/i,
  /^response format\s*:?$/i,
  /^report back\s*:?$/i,
  /^when done\s*:?$/i,
  /^include in (?:the )?response\s*:?$/i,
];

const TASK_SECTION_HEADERS = [
  /^tasks?\s*:?$/i,
  /^requested changes\s*:?$/i,
  /^workstreams?\s*:?$/i,
  /^plan\s*:?$/i,
  /^fixes?\s*:?$/i,
  /^implement\s*:?$/i,
];

const TASK_LEAD_VERBS = /^(fix|add|update|improve|refactor|build|create|implement|remove|validate|write|test|document|ensure|route|investigate|ship|polish|clean up|stabilize|repair)\b/i;
const REPORT_BULLET_PREFIX = /^(root cause|files changed|commit hash|what still remains|remaining issues?|summary|tests run|warnings?)\b/i;

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
    `You are a task planner. Decompose this request into concrete, independent implementation tasks.`,
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
    `- Prefer fewer, coherent tasks over many literal fragments.`,
    `- Group file references under the real implementation task; never emit a standalone file-name task.`,
    `- Ignore report-only sections like Return:, Output:, Deliverables:, or response-format bullets when forming tasks.`,
    `- Scope must be specific (file paths, function names).`,
    `- Acceptance criteria must be concrete and testable.`,
    `- Use "codex" as default agent.`,
    `- Use "parallel" when tasks don't share files.`,
    `- Use "sequential" when later tasks depend on earlier ones.`,
    `- Maximum 6 tasks per plan.`,
  );

  return parts.join("\n");
}

// --- Helper functions ---

function extractTitle(request: string): string {
  const firstSentence = request.split(/[.!?\n]/)[0]?.trim() ?? request;
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + "...";
}

function extractAcceptanceCriteria(request: string): string[] {
  const criteria = collectMeaningfulBullets(splitLines(request));
  if (criteria.length > 0) {
    return criteria;
  }

  return [
    "Implementation matches the request specification",
    "No regressions in existing functionality",
  ];
}

export function decomposeTasks(request: string): TaskSpec[] {
  const numberedTasks = decomposeNumberedTasks(request);
  if (numberedTasks.length >= 2) {
    return numberedTasks;
  }

  const bulletTasks = decomposeBulletTasks(request);
  if (bulletTasks.length >= 2) {
    return bulletTasks;
  }

  return [
    buildTaskSpec(0, request, request, extractAcceptanceCriteria(request)),
  ];
}

function decomposeNumberedTasks(request: string): TaskSpec[] {
  const blocks = extractNumberedBlocks(request);
  if (blocks.length < 2) return [];

  return blocks.map((block, index) => {
    const criteria = collectMeaningfulBullets(block.lines);
    const fileRefs = extractScopeFiles([block.title, ...block.lines].join("\n"));
    const scope = buildTaskScope(block.title, fileRefs, block.lines);
    return buildTaskSpec(index, block.title, scope, criteria);
  });
}

function decomposeBulletTasks(request: string): TaskSpec[] {
  const tasks: TaskSpec[] = [];
  let section: "neutral" | "task" | "report" = "neutral";

  for (const line of splitLines(request)) {
    const trimmed = normalizeText(line);
    if (!trimmed) continue;

    if (isReportSectionHeader(trimmed)) {
      section = "report";
      continue;
    }

    if (isTaskSectionHeader(trimmed)) {
      section = "task";
      continue;
    }

    const bullet = parseBulletLine(trimmed);
    if (!bullet) {
      if (/:$/.test(trimmed)) {
        section = "neutral";
      }
      continue;
    }

    if (section === "report") continue;

    if (isLikelyFileReference(bullet)) {
      if (tasks.length > 0) {
        appendFilesToTaskScope(tasks[tasks.length - 1], extractScopeFiles(bullet));
      }
      continue;
    }

    if (shouldIgnoreStandaloneTaskBullet(bullet)) continue;
    if (section !== "task" && !looksLikeActionableTask(bullet)) continue;

    const criteria = [bullet];
    const files = extractScopeFiles(bullet);
    const scope = buildTaskScope(bullet, files, []);
    tasks.push(buildTaskSpec(tasks.length, bullet, scope, criteria));
  }

  return tasks;
}

interface NumberedBlock {
  title: string;
  lines: string[];
}

function extractNumberedBlocks(request: string): NumberedBlock[] {
  const blocks: NumberedBlock[] = [];
  let current: NumberedBlock | null = null;

  for (const line of splitLines(request)) {
    const trimmed = line.trim();
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      current = {
        title: normalizeText(numbered[1]),
        lines: [],
      };
      blocks.push(current);
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  return blocks.filter((block) => !shouldIgnoreStandaloneTaskBullet(block.title));
}

function buildTaskSpec(
  index: number,
  titleSource: string,
  scope: string,
  acceptanceCriteria: string[],
): TaskSpec {
  return {
    id: nextTaskId(index),
    title: extractTitle(titleSource),
    scope,
    acceptanceCriteria: acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : [normalizeText(titleSource)],
    agent: "codex",
  };
}

function buildTaskScope(title: string, fileRefs: string[], bodyLines: string[]): string {
  const parts = [normalizeText(title)];

  if (fileRefs.length > 0) {
    parts.push(`Relevant files: ${fileRefs.join(", ")}`);
  }

  const contextNotes = bodyLines
    .map((line) => normalizeText(line))
    .filter((line) => {
      if (!line) return false;
      if (parseBulletLine(line) || parseNumberedLine(line)) return false;
      return !isSectionHeader(line);
    })
    .slice(0, 2);

  if (contextNotes.length > 0) {
    parts.push(`Context: ${contextNotes.join(" ")}`);
  }

  return parts.join("\n");
}

function appendFilesToTaskScope(task: TaskSpec, fileRefs: string[]): void {
  if (fileRefs.length === 0) return;

  const uniqueFiles = unique(fileRefs);
  const existingMatch = task.scope.match(/\nRelevant files: (.+)$/m);
  if (!existingMatch) {
    task.scope = `${task.scope}\nRelevant files: ${uniqueFiles.join(", ")}`;
    return;
  }

  const existingFiles = existingMatch[1]
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  const merged = unique([...existingFiles, ...uniqueFiles]);
  task.scope = task.scope.replace(/\nRelevant files: .+$/m, `\nRelevant files: ${merged.join(", ")}`);
}

function collectMeaningfulBullets(lines: string[]): string[] {
  const criteria: string[] = [];
  let inReportSection = false;

  for (const rawLine of lines) {
    const trimmed = normalizeText(rawLine);
    if (!trimmed) continue;

    if (isReportSectionHeader(trimmed)) {
      inReportSection = true;
      continue;
    }

    if (isSectionHeader(trimmed) && !isReportSectionHeader(trimmed)) {
      inReportSection = false;
    }

    const bullet = parseBulletLine(trimmed) ?? parseNumberedLine(trimmed);
    if (!bullet || inReportSection) continue;
    if (shouldIgnoreCriterion(bullet)) continue;

    criteria.push(bullet);
  }

  return unique(criteria);
}

function parseBulletLine(line: string): string | null {
  const match = line.match(/^[-•*]\s+(.+)$/);
  return match ? normalizeText(match[1]) : null;
}

function parseNumberedLine(line: string): string | null {
  const match = line.match(/^\d+[.)]\s+(.+)$/);
  return match ? normalizeText(match[1]) : null;
}

function shouldIgnoreCriterion(text: string): boolean {
  return REPORT_BULLET_PREFIX.test(text) || isLikelyFileReference(text);
}

function shouldIgnoreStandaloneTaskBullet(text: string): boolean {
  return REPORT_BULLET_PREFIX.test(text) || isLikelyFileReference(text);
}

function looksLikeActionableTask(text: string): boolean {
  if (TASK_LEAD_VERBS.test(text)) return true;
  if (/^\d+[.)]\s+/.test(text)) return true;
  return false;
}

function isLikelyFileReference(text: string): boolean {
  const cleaned = text.replace(/[`"'(),]/g, " ").trim();
  if (!/\.[a-z][a-z0-9]{0,4}\b/i.test(cleaned)) return false;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;

  return words.every((word) => /[./]/.test(word) || /^[a-z0-9_-]+$/i.test(word));
}

function isReportSectionHeader(text: string): boolean {
  return REPORT_SECTION_HEADERS.some((pattern) => pattern.test(text));
}

function isTaskSectionHeader(text: string): boolean {
  return TASK_SECTION_HEADERS.some((pattern) => pattern.test(text));
}

function isSectionHeader(text: string): boolean {
  return /:$/.test(text) || isReportSectionHeader(text) || isTaskSectionHeader(text);
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function canParallelize(tasks: TaskSpec[]): boolean {
  if (tasks.length <= 1) return false;

  for (const task of tasks) {
    if (/\b(after|then|다음에|이후에|완료\s*후)\b/i.test(task.scope)) {
      return false;
    }
  }

  const filesByTask = tasks.map((t) => extractScopeFiles(t.scope));

  for (const files of filesByTask) {
    if (files.length === 0) {
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
  const matches = scope.match(/[\w\-./]+\.[a-z][a-z0-9]{0,4}/gi);
  return matches ? [...new Set(matches)] : [];
}
