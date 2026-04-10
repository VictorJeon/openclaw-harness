import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REVIEWER_SYSTEM_PROMPT } from "./reviewer";
import { pluginConfig } from "./shared";

/**
 * OpenRouter-backed secondary reviewer.
 * Uses the OpenRouter API directly (not codex CLI) so we can access
 * any model (DeepSeek, GLM, Qwen, etc.) for cross-architecture consensus.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpenRouterReviewResult {
  output: string;
  model: string;
  error?: string;
}

export async function runReviewerWithOpenRouter(options: {
  prompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<OpenRouterReviewResult> {
  const apiKey = pluginConfig.openRouterApiKey;
  if (!apiKey) {
    throw new Error("openRouterApiKey not configured in harness plugin config");
  }

  const model = options.model ?? pluginConfig.consensusReviewerModel ?? "deepseek/deepseek-v3.2";
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
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Harness Reviewer",
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as any;
    const output = data?.choices?.[0]?.message?.content ?? "";

    return { output, model };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { output: "", model, error: `OpenRouter timeout after ${timeoutMs}ms` };
    }
    return { output: "", model, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}
