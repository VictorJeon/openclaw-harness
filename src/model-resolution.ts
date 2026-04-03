import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface AliasCacheEntry {
  path: string;
  mtimeMs: number;
  aliases: Map<string, string>;
}

let aliasCache: AliasCacheEntry | null = null;

function getOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return join(stateDir, "openclaw.json");

  return join(homedir(), ".openclaw", "openclaw.json");
}

function stripJsonComments(input: string): string {
  let result = "";
  let inString = false;
  let stringQuote = "";
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if ((char === '"' || char === "'" || char === "`")) {
      inString = true;
      stringQuote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    result += char;
  }

  return result;
}

function loadAliasIndex(): Map<string, string> {
  const configPath = getOpenClawConfigPath();
  if (!existsSync(configPath)) return new Map();

  const stat = statSync(configPath);
  if (
    aliasCache &&
    aliasCache.path === configPath &&
    aliasCache.mtimeMs === stat.mtimeMs
  ) {
    return aliasCache.aliases;
  }

  const aliases = new Map<string, string>();

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw));
    const models = parsed?.agents?.defaults?.models;

    if (models && typeof models === "object") {
      for (const [canonicalRef, entry] of Object.entries(models)) {
        const alias = typeof (entry as any)?.alias === "string"
          ? (entry as any).alias.trim()
          : "";
        if (!alias) continue;
        aliases.set(alias.toLowerCase(), canonicalRef.trim());
      }
    }
  } catch (error: any) {
    console.warn(`[model-resolution] Failed to read model aliases from ${configPath}: ${error?.message ?? String(error)}`);
  }

  aliasCache = {
    path: configPath,
    mtimeMs: stat.mtimeMs,
    aliases,
  };

  return aliases;
}

/**
 * Resolve OpenClaw model aliases (agents.defaults.models.*.alias) to canonical
 * provider/model refs before passing them to the Claude SDK.
 */
export function resolveModelAlias(model?: string): string | undefined {
  if (typeof model !== "string") return undefined;

  const trimmed = model.trim();
  if (!trimmed) return undefined;

  // Already canonical provider/model form.
  if (trimmed.includes("/")) return trimmed;

  const aliases = loadAliasIndex();
  return aliases.get(trimmed.toLowerCase()) ?? trimmed;
}

export function isClaudeCompatibleModel(model?: string): boolean {
  const resolved = resolveModelAlias(model);
  if (!resolved) return false;

  const normalized = resolved.toLowerCase();
  return normalized.includes("claude") || normalized.startsWith("anthropic/");
}

/**
 * Claude Code sessions can only launch Claude-compatible models. If the
 * preferred configured model points to a non-Claude provider (for example
 * openai-codex), fall back to the first Claude-compatible candidate.
 */
export function resolveClaudeLaunchModel(...candidates: Array<string | undefined>): string | undefined {
  const resolved = candidates
    .map((candidate) => resolveModelAlias(candidate))
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of resolved) {
    if (isClaudeCompatibleModel(candidate)) return candidate;
  }

  return resolved[0];
}
