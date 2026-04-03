import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { dirname, join, relative, resolve, sep } from "path";

export interface SyncRecoveryResult {
  repoRoot: string;
  backupRoot: string;
  moved: Array<{ original: string; backup: string }>;
}

const UNTRACKED_OVERWRITE_PATTERN = /The following untracked working tree files would be overwritten by (?:merge|checkout|switch):/i;
const STOP_LINE_PATTERN = /Please move or remove them before you (?:merge|switch branches|checkout)\./i;

function sanitizeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function extractBlockingPaths(errorText: string): string[] {
  const lines = errorText.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => UNTRACKED_OVERWRITE_PATTERN.test(line));
  if (startIndex === -1) return [];

  const paths: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (STOP_LINE_PATTERN.test(line) || /^Aborting\b/i.test(line.trim())) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("error:")) continue;
    if (/^hint:/i.test(trimmed)) continue;
    paths.push(trimmed);
  }

  return [...new Set(paths)];
}

function getGitRepoRoot(workdir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function isUntracked(repoRoot: string, relativePath: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", relativePath],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    return output.split(/\r?\n/).some((line) => line.trim() === relativePath);
  } catch {
    return false;
  }
}

function safeMove(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });

  try {
    renameSync(source, destination);
    return;
  } catch (error: any) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }

  const stats = lstatSync(source);
  if (stats.isDirectory()) {
    cpSync(source, destination, { recursive: true, errorOnExist: true });
    rmSync(source, { recursive: true, force: false });
    return;
  }

  cpSync(source, destination, { errorOnExist: true });
  rmSync(source, { force: false });
}

function createUniqueBackupPath(backupRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, "");
  let candidate = join(backupRoot, normalized);
  if (!existsSync(candidate)) return candidate;

  const baseDir = dirname(candidate);
  const fileName = candidate.slice(baseDir.length + 1);
  let index = 2;
  while (true) {
    const next = join(baseDir, `${fileName}.bak-${index}`);
    if (!existsSync(next)) return next;
    index++;
  }
}

export function isRealtimeSyncConflictError(input: unknown): boolean {
  const text = typeof input === "string" ? input : input instanceof Error ? input.message : String(input ?? "");
  return UNTRACKED_OVERWRITE_PATTERN.test(text);
}

/**
 * Recover from Claude/OpenClaw realtime git sync failures caused by untracked
 * files that would be overwritten by pull/merge. We only move paths that are
 * still present and still untracked, preserving user data under
 * .openclaw-harness/realtime-sync-conflicts/<timestamp>/.
 */
export function tryRecoverRealtimeSyncConflict(workdir: string, errorText: string): SyncRecoveryResult | null {
  if (!isRealtimeSyncConflictError(errorText)) return null;

  const repoRoot = getGitRepoRoot(workdir);
  if (!repoRoot) return null;

  const blockingPaths = extractBlockingPaths(errorText);
  if (blockingPaths.length === 0) return null;

  const verified = blockingPaths
    .map((relativePath) => {
      const absolutePath = resolve(repoRoot, relativePath);
      const relativeToRoot = relative(repoRoot, absolutePath);
      if (relativeToRoot.startsWith("..") || relativeToRoot.includes(`..${sep}`)) {
        return null;
      }
      if (!existsSync(absolutePath)) return null;
      if (!isUntracked(repoRoot, relativePath)) return null;
      return { relativePath, absolutePath };
    })
    .filter((entry): entry is { relativePath: string; absolutePath: string } => entry !== null);

  if (verified.length === 0) return null;

  const backupRoot = join(
    repoRoot,
    ".openclaw-harness",
    "realtime-sync-conflicts",
    sanitizeTimestamp(new Date().toISOString()),
  );

  const moved: Array<{ original: string; backup: string }> = [];
  for (const entry of verified) {
    const backupPath = createUniqueBackupPath(backupRoot, entry.relativePath);
    safeMove(entry.absolutePath, backupPath);
    moved.push({
      original: entry.absolutePath,
      backup: backupPath,
    });
  }

  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(
    join(backupRoot, "manifest.json"),
    JSON.stringify(
      {
        recoveredAt: new Date().toISOString(),
        reason: "untracked working tree files would be overwritten by realtime git sync",
        repoRoot,
        errorExcerpt: errorText.slice(0, 4000),
        moved,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    repoRoot,
    backupRoot,
    moved,
  };
}
