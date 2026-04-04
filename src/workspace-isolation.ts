import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve } from "path";

export interface PreparedExecutionWorkspace {
  originalWorkdir: string;
  executionWorkdir: string;
  isolated: boolean;
  statePath?: string;
  cleanupPath?: string;
}

function runGit(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: input == null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    input,
  }).trim();
}

function readGitPatch(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getRepoRoot(workdir: string): string | null {
  try {
    return runGit(workdir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

function hasDirtyWorktree(repoRoot: string): boolean {
  try {
    const status = runGit(repoRoot, ["status", "--porcelain"]);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function copyUntrackedFiles(repoRoot: string, cloneDir: string): void {
  let output = "";
  try {
    output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return;
  }

  const paths = output.split("\0").map((value) => value.trim()).filter(Boolean);
  for (const relativePath of paths) {
    const source = join(repoRoot, relativePath);
    const target = join(cloneDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: false });
  }
}

function writeIsolationState(repoRoot: string, planId: string, executionWorkdir: string): string {
  const statePath = join(repoRoot, ".openclaw-harness", "execution-workspaces", `${planId}.json`);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      planId,
      repoRoot,
      executionWorkdir,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf8",
  );
  return statePath;
}

export function prepareExecutionWorkspace(originalWorkdir: string, planId: string): PreparedExecutionWorkspace {
  const resolvedWorkdir = resolve(originalWorkdir);
  const repoRoot = getRepoRoot(resolvedWorkdir);
  if (!repoRoot || !hasDirtyWorktree(repoRoot)) {
    return {
      originalWorkdir: resolvedWorkdir,
      executionWorkdir: resolvedWorkdir,
      isolated: false,
    };
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-harness-exec-"));
  const tempDir = join(tempRoot, basename(repoRoot));
  runGit(process.cwd(), ["clone", "--quiet", repoRoot, tempDir]);
  runGit(tempDir, ["reset", "--hard", "HEAD"]);

  const trackedPatch = readGitPatch(repoRoot, ["diff", "--binary", "HEAD"]);
  if (trackedPatch.trim()) {
    execFileSync("git", ["apply", "--binary", "-"], {
      cwd: tempDir,
      input: trackedPatch,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  copyUntrackedFiles(repoRoot, tempDir);
  runGit(tempDir, ["add", "-A"]);

  try {
    runGit(tempDir, ["commit", "--quiet", "--no-gpg-sign", "-m", `harness: dirty snapshot ${planId}`]);
  } catch {
    // If nothing was staged after projection, keep the clone anyway.
  }

  const statePath = writeIsolationState(repoRoot, planId, tempDir);
  return {
    originalWorkdir: resolvedWorkdir,
    executionWorkdir: tempDir,
    isolated: true,
    statePath,
    cleanupPath: tempRoot,
  };
}

export function materializeExecutionWorkspace(prepared: PreparedExecutionWorkspace): { applied: boolean; patchPath?: string; error?: string } {
  if (!prepared.isolated) return { applied: false };

  const patch = readGitPatch(prepared.executionWorkdir, ["diff", "--binary", "HEAD"]);
  if (!patch.trim()) {
    try {
      rmSync(prepared.cleanupPath ?? prepared.executionWorkdir, { recursive: true, force: true });
    } catch {}
    if (prepared.statePath) {
      try { rmSync(prepared.statePath, { force: true }); } catch {}
    }
    return { applied: true };
  }

  const patchPath = join(prepared.executionWorkdir, "worker-delta.patch");
  writeFileSync(patchPath, patch, "utf8");

  try {
    execFileSync("git", ["apply", "--binary", patchPath], {
      cwd: prepared.originalWorkdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (plainError: any) {
    try {
      execFileSync("git", ["apply", "--3way", "--binary", patchPath], {
        cwd: prepared.originalWorkdir,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      return {
        applied: false,
        patchPath,
        error: error?.message ?? plainError?.message ?? String(error),
      };
    }
  }

  try {
    rmSync(prepared.cleanupPath ?? prepared.executionWorkdir, { recursive: true, force: true });
  } catch {}
  if (prepared.statePath) {
    try { rmSync(prepared.statePath, { force: true }); } catch {}
  }

  return {
    applied: true,
    patchPath,
  };
}
