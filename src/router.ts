import type { Tier } from "./types";
import { getSessionManager, pluginConfig } from "./shared";

/**
 * Router: classify incoming request complexity into tier 0/1/2.
 *
 * Tier 0: Config/docs/simple patches — caller agent handles directly
 * Tier 1: Simple-to-medium coding — realtime worker + review loop
 * Tier 2: Complex/multi-task — richer decomposition + plan review + same realtime worker path
 *
 * Classification is deterministic:
 *   1. Pattern match: regex for config/doc changes → tier 0
 *   2. Keyword scoring: bug / feature / migration signals → tier 1 or 2
 *   3. Fallback heuristics: ambiguous length / task-count rules
 */

// Tier 0 patterns: settings, docs, trivial patches
const TIER0_PATTERNS = [
  /\b(설정|config|setting|환경)\s*(변경|수정|바꿔|업데이트)/i,
  /\b(오타|typo|오탈자)\s*(수정|고쳐|fix)/i,
  /\b(문서|doc|readme|changelog)\s*(수정|추가|업데이트|작성)/i,
  /\b(버전|version)\s*(올려|bump|업데이트)/i,
  /\bpackage\.json\b.*\b(수정|업데이트)\b/i,
  /\b\.env\b.*\b(수정|추가)\b/i,
  /\btsconfig\b/i,
  /\b(단순|간단)\s*(패치|수정)\b/i,
  // Agent/workspace files
  /\b(AGENTS|MEMORY|SOUL|USER|TOOLS|IDENTITY|HEARTBEAT|BOOTSTRAP)\.md\b/i,
  // Simple line edits
  /\b(한 줄|한줄|one line|1줄)\s*(추가|수정|삭제|변경)/i,
  /\b(주석|코멘트|comment)\s*(추가|수정|삭제)/i,
  // Plist / LaunchAgent config
  /\b(plist|LaunchAgent)\b.*\b(수정|추가|변경)/i,
  // Shell script config changes
  /\b(\.sh|\.toml|\.yaml|\.yml)\b.*\b(수정|변경|업데이트)/i,
  // Import/export tweaks
  /\b(import|export)\s*(추가|수정|삭제)/i,
  // Simple rename/move
  /\b(이름|name)\s*(변경|바꿔|rename)/i,
];

// Tier 1 keywords: straightforward coding tasks
// Note: avoid overly generic words like "수정" or "추가해" alone — those overlap with tier 0
const TIER1_KEYWORDS = [
  "버그", "bug", "fix", "고쳐",
  "새 기능", "new feature", "기능 추가", "기능을 추가",
  "리팩토링", "refactor",
  "테스트", "test", "spec",
  "엔드포인트", "endpoint", "api",
  "컴포넌트", "component",
  "함수", "function", "만들어",
  "스타일", "css", "style",
  "유효성", "validation",
  "클래스", "class",
  "구현", "implement",
];

// Tier 2 keywords: complex, multi-part tasks
const TIER2_KEYWORDS = [
  "마이그레이션", "migration", "migrate",
  "재작성", "rewrite", "재구현",
  "아키텍처", "architecture",
  "전환", "convert", "전체",
  "시스템", "system", "인프라",
  "복합", "통합", "integration",
  "여러 파일", "multiple files",
  "대규모", "large scale",
];

export interface RouteResult {
  tier: Tier;
  confidence: "pattern" | "keyword" | "llm" | "fallback";
  reason: string;
}

export async function classifyRequest(request: string): Promise<RouteResult> {
  const normalized = request.toLowerCase().trim();

  // Layer 1: Pattern match → tier 0
  for (const pattern of TIER0_PATTERNS) {
    if (pattern.test(request)) {
      return {
        tier: 0,
        confidence: "pattern",
        reason: `Pattern match: ${pattern.source}`,
      };
    }
  }

  if (isLikelySingleFeatureWorkflow(request)) {
    return {
      tier: 1,
      confidence: "keyword",
      reason: "Single-feature workflow detected (implementation + test/docs/verify grouped as one task)",
    };
  }

  // Layer 2: Keyword scoring
  let tier1Score = 0;
  let tier2Score = 0;
  const matchedKeywords: string[] = [];

  for (const kw of TIER2_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      tier2Score++;
      matchedKeywords.push(kw);
    }
  }

  for (const kw of TIER1_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      tier1Score++;
      matchedKeywords.push(kw);
    }
  }

  // Heuristic: count commas/tasks as complexity signal
  const taskCount = countTasks(request);

  if (tier2Score >= 2 || taskCount >= 4) {
    return {
      tier: 2,
      confidence: "keyword",
      reason: `Tier 2 keywords: [${matchedKeywords.join(", ")}], tasks: ${taskCount}`,
    };
  }

  if (tier1Score >= 1) {
    return {
      tier: taskCount >= 2 ? 2 : 1,
      confidence: "keyword",
      reason: `Tier 1 keywords: [${matchedKeywords.join(", ")}], tasks: ${taskCount}`,
    };
  }

  if (taskCount >= 2) {
    return {
      tier: taskCount >= 4 ? 2 : 1,
      confidence: "keyword",
      reason: `Multiple tasks detected: ${taskCount}`,
    };
  }

  // Layer 3: LLM classification for ambiguous requests (~500 tokens)
  // Only fires when layers 1+2 are inconclusive. Falls back to heuristic
  // if SessionManager is unavailable or LLM call fails.
  const llmResult = await classifyWithLlm(request);
  if (llmResult) return llmResult;

  // Layer 3 fallback: heuristic for when LLM is unavailable
  if (normalized.length > 200) {
    return {
      tier: 2,
      confidence: "fallback",
      reason: `Long ambiguous request (${normalized.length} chars), LLM unavailable, heuristic chose tier 2`,
    };
  }

  return {
    tier: 1,
    confidence: "fallback",
    reason: "No strong signals, LLM unavailable — heuristic defaulted to tier 1",
  };
}

/**
 * Count the number of distinct tasks/work items in a request.
 * Looks for numbered lists, commas with verbs, "and" conjunctions, etc.
 */
function countTasks(request: string): number {
  if (isLikelySingleFeatureWorkflow(request)) {
    return 1;
  }

  // Count numbered items (1. 2. 3. or 1) 2) 3))
  const numbered = request.match(/(?:^|\n)\s*\d+[.)]/g);
  if (numbered && numbered.length >= 2) return numbered.length;

  // Count bullet points
  const bullets = request.match(/(?:^|\n)\s*[-•*]\s+/g);
  if (bullets && bullets.length >= 2) return bullets.length;

  // Count "하고" / "and" / comma-separated verb phrases
  const conjunctions = request.match(/[,，]\s*(?:그리고|하고|and|also|또)/gi);
  if (conjunctions) return conjunctions.length + 1;

  // Simple comma-separated task detection
  const commaSegments = request.split(/[,，]/).filter((s) => s.trim().length > 10);
  if (commaSegments.length >= 3) return commaSegments.length;

  return 0;
}

// ── Layer 3: LLM classification ──

const LLM_ROUTER_PROMPT = `You are a task complexity classifier. Given a coding task request, classify it as exactly one tier:

- tier 1: Single bug fix, single feature, single refactor, or a small focused change. One logical unit of work.
- tier 2: Multiple interrelated changes, migration, architecture change, multi-file refactor, or a task that needs decomposition into subtasks.

Respond with ONLY a JSON object, no other text:
{"tier": 1 or 2, "reason": "one sentence explanation"}`;

const LLM_ROUTER_TIMEOUT_MS = 15_000;

async function classifyWithLlm(request: string): Promise<RouteResult | null> {
  const sm = getSessionManager();
  if (!sm) return null;

  const routerModel = pluginConfig.plannerModel || "sonnet";

  try {
    const session = sm.spawn({
      prompt: `${LLM_ROUTER_PROMPT}\n\nRequest:\n${request.slice(0, 2000)}`,
      name: `router-llm-${Date.now()}`,
      workdir: process.cwd(),
      model: routerModel,
      maxBudgetUsd: 0.05,
      permissionMode: "default",
      allowedTools: [],
      multiTurn: false,
      internal: true,
    });

    // Poll for completion with tight timeout
    const startTime = Date.now();
    while (Date.now() - startTime < LLM_ROUTER_TIMEOUT_MS) {
      const s = sm.get(session.id);
      if (!s) break;
      if (s.status === "completed" || s.status === "failed" || s.status === "killed") {
        const output = s.getOutput().join("\n").trim();
        const parsed = parseLlmRouterOutput(output);
        if (parsed) {
          console.log(`[router] LLM classification: tier=${parsed.tier}, model=${routerModel}, reason=${parsed.reason}`);
          return parsed;
        }
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    // Timeout — kill and fall through
    try { sm.kill(session.id); } catch { /* best-effort */ }
  } catch (err: any) {
    console.warn(`[router] LLM classification failed: ${err?.message ?? String(err)}`);
  }

  return null;
}

function parseLlmRouterOutput(output: string): RouteResult | null {
  // Try to extract JSON from model output
  const jsonMatch = output.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const tier = parsed.tier === 1 ? 1 : parsed.tier === 2 ? 2 : null;
    if (tier === null) return null;

    return {
      tier,
      confidence: "llm",
      reason: `LLM: ${typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "classified"}`,
    };
  } catch {
    return null;
  }
}

function isLikelySingleFeatureWorkflow(request: string): boolean {
  const normalized = request.toLowerCase();
  if (/(migration|migrate|rewrite|architecture|system|integration|infra|multiple files|large scale|마이그레이션|재작성|아키텍처|시스템|통합|인프라|여러 파일|대규모)/i.test(request)) {
    return false;
  }

  const explicitFiles = request.match(/[\w\-./]+\.\w{1,5}/g) ?? [];
  if (explicitFiles.length > 3) {
    return false;
  }

  const hasImplementation = /(create|add|update|modify|implement|write|build|make|생성|추가|수정|구현|작성|만들)/i.test(request);
  const hasSupportSteps = /(readme|pytest|test|verify|validation|commit|usage|example|readable|minimal|simple|문서|테스트|검증|커밋|예시|간단|최소)/i.test(request);
  const hasMultiAreaSignals = /(backend and frontend|frontend and backend|api and ui|여러 서비스|여러 컴포넌트|서로 다른 모듈)/i.test(normalized);

  return hasImplementation && hasSupportSteps && !hasMultiAreaSignals;
}
