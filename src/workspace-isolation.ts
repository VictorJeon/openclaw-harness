import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
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

function hasHeadCommit(repoRoot: string): boolean {
  try {
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

const PROJECT_CONTEXT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
];

function copyFileIntoClone(repoRoot: string, cloneDir: string, relativePath: string): void {
  const source = join(repoRoot, relativePath);
  if (!existsSync(source)) return;
  const target = join(cloneDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: false });
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
    output = "";
  }

  const copied = new Set<string>();
  const paths = output.split("\0").map((value) => value.trim()).filter(Boolean);
  for (const relativePath of paths) {
    copyFileIntoClone(repoRoot, cloneDir, relativePath);
    copied.add(relativePath);
  }

  for (const relativePath of PROJECT_CONTEXT_FILES) {
    if (copied.has(relativePath)) continue;
    copyFileIntoClone(repoRoot, cloneDir, relativePath);
  }
}

function copyWorkingTreeContents(repoRoot: string, cloneDir: string): void {
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    cpSync(join(repoRoot, entry.name), join(cloneDir, entry.name), {
      recursive: true,
      dereference: false,
    });
  }
}

function configureSnapshotGitIdentity(repoRoot: string): void {
  runGit(repoRoot, ["config", "user.name", "OpenClaw Harness"]);
  runGit(repoRoot, ["config", "user.email", "harness@openclaw.local"]);
}

const EXECUTION_WORKSPACE_ROOT = join(homedir(), ".openclaw", "harness-execution-workspaces");

type IsolationState = {
  planId: string;
  repoRoot: string;
  executionWorkdir: string;
  cleanupRoot: string;
  createdAt: string;
};

function isolationStatePath(planId: string): string {
  return join(EXECUTION_WORKSPACE_ROOT, "state", `${planId}.json`);
}

function writeIsolationState(repoRoot: string, planId: string, executionWorkdir: string, cleanupRoot: string): string {
  const statePath = isolationStatePath(planId);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      planId,
      repoRoot,
      executionWorkdir,
      cleanupRoot,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf8",
  );
  return statePath;
}

function readIsolationState(planId: string): IsolationState | null {
  const statePath = isolationStatePath(planId);
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as IsolationState;
    if (!parsed?.executionWorkdir || !parsed?.repoRoot) return null;
    return parsed;
  } catch {
    return null;
  }
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

  const existingState = readIsolationState(planId);
  if (
    existingState
    && resolve(existingState.repoRoot) === repoRoot
    && existsSync(existingState.executionWorkdir)
  ) {
    return {
      originalWorkdir: resolvedWorkdir,
      executionWorkdir: existingState.executionWorkdir,
      isolated: true,
      statePath: isolationStatePath(planId),
      cleanupPath: existingState.cleanupRoot,
    };
  }

  mkdirSync(EXECUTION_WORKSPACE_ROOT, { recursive: true });
  const tempRoot = mkdtempSync(join(EXECUTION_WORKSPACE_ROOT, `${planId}-`));
  const tempDir = join(tempRoot, basename(repoRoot));
  const repoHasHead = hasHeadCommit(repoRoot);

  runGit(process.cwd(), ["clone", "--quiet", repoRoot, tempDir]);
  configureSnapshotGitIdentity(tempDir);

  if (repoHasHead) {
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
  } else {
    copyWorkingTreeContents(repoRoot, tempDir);
  }

  runGit(tempDir, ["add", "-A"]);

  try {
    runGit(tempDir, ["commit", "--quiet", "--no-gpg-sign", "-m", `harness: dirty snapshot ${planId}`]);
  } catch {
    // If nothing was staged after projection, keep the clone anyway.
  }

  const statePath = writeIsolationState(repoRoot, planId, tempDir, tempRoot);
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

  runGit(prepared.executionWorkdir, ["add", "-A"]);
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
