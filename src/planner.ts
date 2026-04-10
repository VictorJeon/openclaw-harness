import type { HarnessPlan, TaskSpec, Tier, PlannerMetadata } from "./types";
import { getSessionManager, pluginConfig } from "./shared";

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
      plannerMetadata: {
        backend: "heuristic",
        fallback: false,
      },
    };
  }

  // Tier 2: heuristic decomposition fallback
  const tasks = decomposeTasks(request);
  const mode = tasks.length === 1 ? "solo" : canParallelize(tasks) ? "parallel" : "sequential";

  return {
    id: nextPlanId(),
    originalRequest: request,
    tasks,
    mode,
    estimatedComplexity: "high",
    tier: 2,
    plannerMetadata: {
      backend: "heuristic",
      fallback: false,
    },
  };
}

/**
 * Generate the LLM prompt for task decomposition (tier 2).
 * This prompt is sent to the internal Claude planner.
 *
 * Contract: The planner MUST return a single fenced JSON block.
 * Any prose outside the fenced block is ignored by the parser.
 */
export function buildPlannerPrompt(request: string, memoryContext: string): string {
  const parts = [
    `You are a task planner. Decompose this request into concrete, independent implementation tasks.`,
    ``,
    `IMPORTANT: Return your plan as a single fenced JSON code block. Do not use YAML.`,
    `Any text outside the JSON code block will be ignored.`,
    ``,
    `## Request`,
    request,
  ];

  if (memoryContext) {
    parts.push(``, `## Memory Context (previous work)`, memoryContext);
  }

  parts.push(
    ``,
    `## Output Format`,
    `Respond with exactly one fenced JSON block:`,
    ``,
    "```json",
    `{`,
    `  "tasks": [`,
    `    {`,
    `      "id": "task-1",`,
    `      "title": "Short descriptive title",`,
    `      "scope": "specific files/functions to modify",`,
    `      "acceptance_criteria": ["concrete, testable criterion"],`,
    `      "agent": "codex"`,
    `    }`,
    `  ],`,
    `  "mode": "parallel | sequential | solo",`,
    `  "estimated_complexity": "low | medium | high"`,
    `}`,
    "```",
    ``,
    `## Rules`,
    `- Prefer fewer, coherent tasks over many literal fragments.`,
    `- Group file references under the real implementation task; never emit a standalone file-name task.`,
    `- Keep implementation + tests + build verification together when they belong to one change. Do NOT split tests-only or verification-only follow-up tasks unless they operate on disjoint files.`,
    `- Ignore report-only sections like Return:, Output:, Deliverables:, or response-format bullets when forming tasks.`,
    `- Scope must be specific (file paths, function names).`,
    `- Acceptance criteria must be concrete and testable.`,
    `- Use "codex" as default agent unless a Claude worker is clearly better.`,
    `- Use "parallel" when tasks don't share files.`,
    `- Use "sequential" when later tasks depend on earlier ones.`,
    `- Maximum 6 tasks per plan.`,
  );

  return parts.join("\n");
}

// --- Model-backed planner (Tier 2) ---

export interface PlannerRunInput {
  prompt: string;
  requestedModel: string;
  workdir: string;
}

export interface PlannerRunResult {
  output: string;
  launchModel?: string;
}

export type PlannerModelRunner = (input: PlannerRunInput) => Promise<PlannerRunResult>;

/**
 * Parsed planner output shape for strict JSON planner responses.
 */
export interface ParsedPlannerOutput {
  tasks: Array<{ id: string; title: string; scope: string; acceptance_criteria: string[]; agent: string }>;
  mode: string;
  estimated_complexity: string;
}

/**
 * Extract a fenced JSON block from model output.
 * Accepts ```json ... ``` blocks. Ignores any prose outside the fence.
 * Returns null if no valid fenced JSON block is found.
 */
export function extractFencedJson(output: string): string | null {
  // Match ```json ... ``` (greedy inner match, last fence wins if multiple)
  const matches = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (matches.length > 0) {
    // Use the last match (in case the model includes examples before the real output)
    return matches[matches.length - 1][1].trim();
  }

  // Fallback: try a generic ``` ... ``` block if the content looks like JSON
  const genericMatches = [...output.matchAll(/```\s*\n([\s\S]*?)```/g)];
  for (let i = genericMatches.length - 1; i >= 0; i--) {
    const content = genericMatches[i][1].trim();
    if (content.startsWith("{") || content.startsWith("[")) {
      return content;
    }
  }

  return null;
}

/**
 * Validate and normalize a single task from parsed JSON.
 * Returns null if the task is malformed.
 */
function validatePlannerTask(raw: any, index: number): ParsedPlannerOutput["tasks"][0] | null {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `task-${index + 1}`;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null;
  if (!title) return null; // title is required
  if (shouldIgnoreStandaloneTaskBullet(title)) return null;

  const scope = typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : title;
  const normalizedScope = scope.trim() || title;
  const agent = typeof raw.agent === "string" && raw.agent.trim() ? raw.agent.trim() : "codex";

  let acceptanceCriteria: string[] = [];
  if (Array.isArray(raw.acceptance_criteria)) {
    acceptanceCriteria = raw.acceptance_criteria
      .filter((c: any) => typeof c === "string" && c.trim())
      .map((c: string) => c.trim());
  }
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria = [title];
  }

  return { id, title, scope: normalizedScope, acceptance_criteria: acceptanceCriteria, agent };
}

const VALID_MODES = new Set(["parallel", "sequential", "solo"]);
const VALID_COMPLEXITIES = new Set(["low", "medium", "high"]);

/**
 * Parse planner output using strict JSON extraction + schema validation.
 *
 * Strategy:
 *   1. Extract fenced JSON from the model output (ignores surrounding prose).
 *   2. JSON.parse the extracted block.
 *   3. Validate the schema: tasks array with required fields, mode, complexity.
 *   4. Returns null on any parse/validation failure.
 *
 * This replaces the previous YAML-lite regex parser (parsePlannerYaml).
 */
export function parsePlannerJson(output: string): ParsedPlannerOutput | null {
  try {
    const jsonStr = extractFencedJson(output);
    if (!jsonStr) {
      // Last-resort: try to parse the entire output as JSON (no fence)
      const trimmed = output.trim();
      if (trimmed.startsWith("{")) {
        return parsePlannerJsonFromString(trimmed);
      }
      return null;
    }

    return parsePlannerJsonFromString(jsonStr);
  } catch {
    return null;
  }
}

function parsePlannerJsonFromString(jsonStr: string): ParsedPlannerOutput | null {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return null;

  const tasks: ParsedPlannerOutput["tasks"] = [];
  for (let i = 0; i < parsed.tasks.length; i++) {
    const validated = validatePlannerTask(parsed.tasks[i], i);
    if (validated) tasks.push(validated);
  }

  if (tasks.length === 0) return null;

  const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
  const complexityRaw = typeof parsed.estimated_complexity === "string"
    ? parsed.estimated_complexity.trim().toLowerCase()
    : "";

  return {
    tasks,
    mode: VALID_MODES.has(modeRaw) ? modeRaw : "sequential",
    estimated_complexity: VALID_COMPLEXITIES.has(complexityRaw) ? complexityRaw : "high",
  };
}

function yamlToHarnessPlan(
  parsed: ParsedPlannerOutput,
  request: string,
  metadata: PlannerMetadata,
  tier: Tier = 2,
): HarnessPlan {
  const normalized = normalizePlannerTasks(parsed.tasks);
  const pruned = pruneRedundantPlannerTasks(normalized, request);
  const tasks: TaskSpec[] = pruned.map((task, index) => ({
    id: nextTaskId(index),
    title: task.title.length > 60 ? task.title.slice(0, 57) + "..." : task.title,
    scope: task.scope,
    acceptanceCriteria: task.acceptance_criteria,
    agent: task.agent === "claude" ? "claude" : "codex",
  }));

  const cappedTasks = tasks.slice(0, 6);
  const modeNorm = parsed.mode.toLowerCase();
  const complexityNorm = parsed.estimated_complexity.toLowerCase();

  return {
    id: nextPlanId(),
    originalRequest: request,
    tasks: cappedTasks,
    mode: cappedTasks.length === 1
      ? "solo"
      : modeNorm === "parallel"
        ? "parallel"
        : modeNorm === "solo"
          ? "solo"
          : "sequential",
    estimatedComplexity:
      complexityNorm === "low"
        ? "low"
        : complexityNorm === "medium"
          ? "medium"
          : "high",
    tier,
    plannerMetadata: metadata,
  };
}

function pruneRedundantPlannerTasks(
  tasks: ParsedPlannerOutput["tasks"],
  request: string,
): ParsedPlannerOutput["tasks"] {
  if (tasks.length <= 1) return tasks;

  const cleanupSignals = /(abort older active|stale harness runs|leftover pid|lock files?|clean state|terminate older)/i;
  const outputContractSignals = /(return exactly|output only|artifact path|five lines|stdout|stderr|exit code|final realtime status|first blocking error)/i;
  const requestSuggestsSingleFlow = cleanupSignals.test(request) && outputContractSignals.test(request);
  if (!requestSuggestsSingleFlow) return tasks;

  const verificationSignals = /(verify|validation|validate|smoke|report|return exactly|output only|artifact path|five lines|stdout|stderr|exit code|final realtime status|first blocking error)/i;
  const implementationTasks = tasks.filter((task) => !verificationSignals.test(`${task.title}\n${task.scope}`));
  const verificationTasks = tasks.filter((task) => verificationSignals.test(`${task.title}\n${task.scope}`));

  if (implementationTasks.length !== 1 || verificationTasks.length === 0) {
    return tasks;
  }

  const primary = {
    ...implementationTasks[0],
    acceptance_criteria: unique([
      ...implementationTasks[0].acceptance_criteria,
      ...verificationTasks.flatMap((task) => task.acceptance_criteria),
    ]),
  };
  primary.scope = mergeScope(
    primary.scope,
    verificationTasks.map((task) => task.scope).join("\n"),
  );
  return [primary];
}

function normalizePlannerTasks(
  tasks: ParsedPlannerOutput["tasks"],
): ParsedPlannerOutput["tasks"] {
  const merged: ParsedPlannerOutput["tasks"] = [];

  for (const task of tasks) {
    const previous = merged[merged.length - 1];
    if (previous && shouldMergePlannerTask(previous, task)) {
      previous.scope = mergeScope(previous.scope, task.scope);
      previous.acceptance_criteria = unique([
        ...previous.acceptance_criteria,
        ...task.acceptance_criteria,
      ]);
      continue;
    }
    merged.push({
      ...task,
      acceptance_criteria: [...task.acceptance_criteria],
    });
  }

  return merged;
}

function shouldMergePlannerTask(
  previous: ParsedPlannerOutput["tasks"][0],
  current: ParsedPlannerOutput["tasks"][0],
): boolean {
  const currentText = `${current.title}\n${current.scope}\n${current.acceptance_criteria.join("\n")}`;
  const currentFiles = extractScopeFiles(current.scope);
  const prevFiles = extractScopeFiles(previous.scope);

  const testOnlyFiles = currentFiles.length > 0 && currentFiles.every(isTestFile);
  const testsOnlyTask = /(test|tests|pytest|spec|unit test|integration test)/i.test(currentText)
    && (testOnlyFiles || currentFiles.length === 0);
  const verificationOnlyTask = /(verify|validation|build|dry-run|smoke|summary|report|commit hash|files changed)/i.test(currentText)
    && currentFiles.every((file) => isTestFile(file) || !file);
  const overlapsPrevious = currentFiles.length === 0
    || currentFiles.some((file) => prevFiles.includes(file))
    || currentFiles.every(isTestFile);

  return overlapsPrevious && (testsOnlyTask || verificationOnlyTask);
}

function mergeScope(base: string, extra: string): string {
  const normalizedBase = normalizeText(base);
  const normalizedExtra = normalizeText(extra);
  if (!normalizedExtra || normalizedBase.includes(normalizedExtra)) {
    return base;
  }
  return `${base}\nAlso include: ${normalizedExtra}`;
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests)\//i.test(file) || /\.(test|spec)\.[^.]+$/i.test(file);
}

function uniquePlannerModels(models: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const model of models) {
    const normalized = model.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function formatPlannerFailures(failures: string[]): string | undefined {
  if (failures.length === 0) return undefined;
  return failures.join("; ");
}

async function runPlannerWithSession(input: PlannerRunInput): Promise<PlannerRunResult> {
  const sessionManager = getSessionManager();
  if (!sessionManager) {
    throw new Error("SessionManager not available for model-backed planner");
  }

  const plannerSession = sessionManager.spawn({
    prompt: input.prompt,
    name: `planner-${input.requestedModel.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`,
    workdir: input.workdir,
    model: input.requestedModel,
    maxBudgetUsd: 0.5,
    permissionMode: "default",
    allowedTools: [],
    multiTurn: false,
    internal: true,
  });

  const output = await waitForPlannerOutput(plannerSession.id);
  if (!output.trim()) {
    throw new Error("Planner session produced no assistant output");
  }

  return {
    output,
    launchModel: plannerSession.model ?? input.requestedModel,
  };
}

/**
 * Run the model-backed planner for tier-2 requests.
 *
 * Fallback chain:
 *   1. Primary: plannerModel or "opus" (Opus-compatible Claude path)
 *   2. Fallback: "sonnet" (Sonnet-compatible Claude path)
 *   3. Final fallback: current heuristic planner
 */
export async function buildModelPlan(
  request: string,
  memoryContext: string = "",
  workdir: string = process.cwd(),
  runner: PlannerModelRunner = runPlannerWithSession,
  tier: 1 | 2 = 2,
): Promise<HarnessPlan> {
  const prompt = buildPlannerPrompt(request, memoryContext);
  const plannerModels = uniquePlannerModels([
    pluginConfig.plannerModel || "opus",
    "sonnet",
  ]);
  const failures: string[] = [];

  for (const requestedModel of plannerModels) {
    try {
      console.log(`[planner] Attempting model-backed planning with model=${requestedModel}, tier=${tier}`);
      const result = await runner({ prompt, requestedModel, workdir });
      const parsed = parsePlannerJson(result.output);
      if (!parsed) {
        throw new Error("Failed to parse planner output: model did not return valid fenced JSON");
      }

      const metadata: PlannerMetadata = {
        backend: "model",
        model: result.launchModel ?? requestedModel,
        fallback: failures.length > 0,
        fallbackReason: formatPlannerFailures(failures),
      };

      console.log(`[planner] Model-backed plan created: model=${metadata.model ?? requestedModel}, tasks=${parsed.tasks.length}, mode=${parsed.mode}`);
      return yamlToHarnessPlan(parsed, request, metadata, tier);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      failures.push(`${requestedModel}: ${message}`);
      console.warn(`[planner] Model planner failed (model=${requestedModel}): ${message}`);
    }
  }

  console.log(`[planner] All model attempts failed, falling back to heuristic planner`);
  const heuristicPlan = buildPlan(request, tier, memoryContext);
  heuristicPlan.plannerMetadata = {
    backend: "heuristic",
    fallback: true,
    fallbackReason: formatPlannerFailures(failures) ?? "Model planner unavailable",
  };
  return heuristicPlan;
}

/**
 * Wait for a planner session to complete and return its output text.
 * Timeout: 2 minutes (planners should be fast).
 */
async function waitForPlannerOutput(sessionId: string): Promise<string> {
  const maxWaitMs = 2 * 60 * 1000;
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const session = getSessionManager()?.get(sessionId);
    if (!session) return "";

    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return session.getOutput().join("\n");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  getSessionManager()?.kill(sessionId);
  return "";
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
