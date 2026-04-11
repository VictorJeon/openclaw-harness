import type { Tier } from "./types";
import { getSessionManager, pluginConfig } from "./shared";

/**
 * Router: classify incoming request complexity into tier 0/1/2.
 *
 * Tier 0: Config/docs/simple patches — caller agent handles directly
 * Tier 1: Simple-to-medium coding — realtime worker + review loop
 * Tier 2: Complex/multi-task — richer decomposition + plan review + same realtime worker path
 *
 * Classification flow:
 *   1. Pattern match: regex for config/doc changes → tier 0
 *   2. LLM classification: all other requests → tier 1 or 2
 *   3. LLM failure fallback: → tier 1 (conservative default)
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

export interface RouteResult {
  tier: Tier;
  confidence: "pattern" | "llm" | "fallback";
  reason: string;
}

export async function classifyRequest(request: string): Promise<RouteResult> {
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

  // Layer 2: LLM classification for everything that didn't match patterns
  const llmResult = await classifyWithLlm(request);
  if (llmResult) return llmResult;

  // LLM unavailable/failed — conservative fallback to tier 1
  return {
    tier: 1,
    confidence: "fallback",
    reason: "LLM classification unavailable — defaulted to tier 1",
  };
}


// ── LLM classification ──

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

