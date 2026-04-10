import { REVIEWER_SYSTEM_PROMPT } from "./reviewer";
import { pluginConfig } from "./shared";

/**
 * Secondary reviewer via external API (OpenAI-compatible).
 * Supports any OpenAI-compatible endpoint: OpenRouter, Z.ai, etc.
 *
 * Config precedence:
 *   1. consensusReviewerEndpoint (explicit URL)
 *   2. If key starts with "sk-or-" → OpenRouter
 *   3. Otherwise → Z.ai coding endpoint (default)
 */

const DEFAULT_TIMEOUT_MS = 120_000;

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const ZAI_CODING_ENDPOINT = "https://api.z.ai/api/coding/paas/v4/chat/completions";

function resolveEndpoint(): string {
  if (pluginConfig.consensusReviewerEndpoint) {
    return pluginConfig.consensusReviewerEndpoint;
  }
  const key = pluginConfig.consensusReviewerApiKey ?? pluginConfig.openRouterApiKey ?? "";
  if (key.startsWith("sk-or-")) return OPENROUTER_ENDPOINT;
  return ZAI_CODING_ENDPOINT;
}

function resolveApiKey(): string | undefined {
  return pluginConfig.consensusReviewerApiKey ?? pluginConfig.openRouterApiKey;
}

export interface SecondaryReviewResult {
  output: string;
  model: string;
  error?: string;
}

export async function runReviewerWithSecondaryApi(options: {
  prompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<SecondaryReviewResult> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("No API key configured for secondary reviewer (consensusReviewerApiKey or openRouterApiKey)");
  }

  const endpoint = resolveEndpoint();
  const model = options.model ?? pluginConfig.consensusReviewerModel ?? "glm-5.1";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: REVIEWER_SYSTEM_PROMPT },
      { role: "user", content: options.prompt },
    ],
    max_tokens: 2000,
    temperature: 0,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    // OpenRouter-specific headers
    if (endpoint === OPENROUTER_ENDPOINT) {
      headers["HTTP-Referer"] = "https://openclaw.ai";
      headers["X-Title"] = "OpenClaw Harness Reviewer";
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Secondary reviewer API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as any;
    const output = data?.choices?.[0]?.message?.content ?? "";

    return { output, model };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { output: "", model, error: `Secondary reviewer timeout after ${timeoutMs}ms` };
    }
    return { output: "", model, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Backward-compatible alias
export { runReviewerWithSecondaryApi as runReviewerWithOpenRouter };
export type { SecondaryReviewResult as OpenRouterReviewResult };
