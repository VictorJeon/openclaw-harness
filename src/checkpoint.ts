import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { kill } from "process";
import { homedir } from "os";
import { join, resolve } from "path";
import type { CheckpointData, HarnessPlan, TaskStatus, WorkerResult, ReviewResult } from "./types";

function normalizeWorkdirPath(workdir: string): string {
  const resolved = resolve(workdir);
  try {
    return typeof (realpathSync as any).native === "function"
      ? (realpathSync as any).native(resolved)
      : realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Checkpoint: Task-level state persistence.
 *
 * Saves state to /tmp/harness/<run-id>/checkpoint.json
 * so that if a Worker/session dies, completed tasks can be skipped
 * and the harness can resume from where it left off.
 *
 * Rules:
 *   - Updated on every task completion / review pass
 *   - Read on harness restart to determine resume point
 *   - Status "complete" means all tasks passed review
 */

function checkpointDir(workdir: string, runId: string): string {
  return join("/tmp", "harness", runId);
}

function checkpointPath(workdir: string, runId: string): string {
  return join(checkpointDir(workdir, runId), "checkpoint.json");
}

/**
 * Initialize a checkpoint for a new harness run.
 */
export function initCheckpoint(plan: HarnessPlan, workdir: string, executionWorkdir: string = workdir): CheckpointData {
  const checkpoint: CheckpointData = {
    runId: plan.id,
    workdir: normalizeWorkdirPath(workdir),
    executionWorkdir: normalizeWorkdirPath(executionWorkdir),
    status: "running",
    plan,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      status: "pending" as TaskStatus,
    })),
    sessions: {} as Record<string, { worker?: string; reviewer?: string }>,
    lastUpdated: new Date().toISOString(),
  };

  saveCheckpoint(checkpoint, workdir);
  return checkpoint;
}

/**
 * Save checkpoint to disk.
 */
export function saveCheckpoint(checkpoint: CheckpointData, workdir: string): void {
  const dir = checkpointDir(workdir, checkpoint.runId);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const path = checkpointPath(workdir, checkpoint.runId);
    writeFileSync(path, JSON.stringify(checkpoint, null, 2));
    console.log(`[checkpoint] Saved: ${path}`);
  } catch (err: any) {
    console.error(`[checkpoint] Failed to save: ${err.message}`);
  }
}

/**
 * Load checkpoint from disk. Returns null if not found.
 */
export function loadCheckpoint(runId: string, workdir: string): CheckpointData | null {
  const path = checkpointPath(workdir, runId);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as CheckpointData;
  } catch (err: any) {
    console.error(`[checkpoint] Failed to load: ${err.message}`);
    return null;
  }
}

/**
 * Update task status in checkpoint.
 */
export function updateTaskStatus(
  checkpoint: CheckpointData,
  taskId: string,
  status: TaskStatus,
  workdir: string,
  extra?: {
    reviewPassed?: boolean;
    reviewLoop?: number;
    workerResult?: WorkerResult;
    reviewResult?: ReviewResult;
  },
): void {
  const task = checkpoint.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.warn(`[checkpoint] Task ${taskId} not found in checkpoint ${checkpoint.runId}`);
    return;
  }

  task.status = status;
  if (extra) {
    if (extra.reviewPassed !== undefined) task.reviewPassed = extra.reviewPassed;
    if (extra.reviewLoop !== undefined) task.reviewLoop = extra.reviewLoop;
    if (extra.workerResult) task.workerResult = extra.workerResult;
    if (extra.reviewResult) task.reviewResult = extra.reviewResult;
  }

  checkpoint.lastUpdated = new Date().toISOString();

  const hasActive = checkpoint.tasks.some(
    (t) => t.status === "in-progress" || t.status === "in-review",
  );
  const hasFailed = checkpoint.tasks.some((t) => t.status === "failed");
  const allDone = checkpoint.tasks.every(
    (t) => t.status === "completed" || t.status === "failed",
  );
  const allPassed = checkpoint.tasks.every(
    (t) => t.status === "completed" && t.reviewPassed,
  );

  if (allDone) {
    checkpoint.status = allPassed ? "complete" : "failed";
  } else if (hasFailed && !hasActive) {
    checkpoint.status = "failed";
  } else {
    checkpoint.status = "running";
  }

  saveCheckpoint(checkpoint, workdir);
}

/**
 * Record session IDs in checkpoint for resume.
 */
export function recordSession(
  checkpoint: CheckpointData,
  taskId: string,
  role: "worker" | "reviewer",
  sessionId: string,
  workdir: string,
): void {
  if (!checkpoint.sessions[taskId]) {
    checkpoint.sessions[taskId] = {};
  }
  checkpoint.sessions[taskId][role] = sessionId;
  checkpoint.lastUpdated = new Date().toISOString();
  saveCheckpoint(checkpoint, workdir);
}

/**
 * Get tasks that need to be executed (not yet completed).
 */
export function getPendingTasks(checkpoint: CheckpointData): string[] {
  return checkpoint.tasks
    .filter((t) => t.status === "pending" || t.status === "in-progress")
    .map((t) => t.id);
}

function isRecordedSessionAlive(sessionId?: string): boolean {
  if (!sessionId) return false;
  const pidMatch = sessionId.match(/-(\d{5,})$/);
  if (!pidMatch) return true;
  const pid = Number(pidMatch[1]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkpointHasLiveSession(checkpoint: CheckpointData): boolean {
  const taskStates = new Map(checkpoint.tasks.map((task) => [task.id, task.status]));
  return Object.entries(checkpoint.sessions ?? {}).some(([taskId, session]) => {
    const status = taskStates.get(taskId);
    if (status !== "in-progress" && status !== "in-review") return false;
    return isRecordedSessionAlive(session.worker) || isRecordedSessionAlive(session.reviewer);
  });
}

const MAX_AUTO_RESUME_COUNT = 5;

function reconcileStaleCheckpoint(checkpoint: CheckpointData, workdir: string): CheckpointData {
  if (checkpoint.status !== "running") return checkpoint;
  if (checkpointHasLiveSession(checkpoint)) return checkpoint;

  // If a harness background task currently owns this checkpoint, do NOT
  // reconcile. The owner sets inFlightSince when it starts and clears it
  // when it finishes. Remote workers appear "dead" to local PID checks
  // (checkpointHasLiveSession), but the owning background task is still
  // actively awaiting them. Reconciling here would reset in-progress tasks
  // to pending, corrupting the owner's in-memory state.
  // Allow reconcile only if inFlightSince is older than 30 min (stale owner).
  if (checkpoint.inFlightSince) {
    const flightAge = Date.now() - Date.parse(checkpoint.inFlightSince);
    if (!isNaN(flightAge) && flightAge < 30 * 60 * 1000) {
      return checkpoint; // owned — hands off
    }
  }

  // Worker/reviewer processes are dead (gateway restart, crash, stream hang, …).
  // Reset in-progress / in-review tasks to pending so the next harness.execute
  // with the same request can pick them up via findRecoverableCheckpoint.
  // Completed tasks are left intact and will be skipped on resume.
  const resumableIds = new Set(
    checkpoint.tasks
      .filter((task) => task.status === "in-progress" || task.status === "in-review")
      .map((task) => task.id),
  );

  if (resumableIds.size > 0) {
    const nextResumeCount = (checkpoint.resumeCount ?? 0) + 1;

    if (nextResumeCount > MAX_AUTO_RESUME_COUNT) {
      // Too many consecutive worker deaths on the same checkpoint — bail out
      // to failed so we do not loop forever on a structurally broken task.
      checkpoint.tasks = checkpoint.tasks.map((task) => {
        if (resumableIds.has(task.id)) {
          return { ...task, status: "failed", reviewPassed: false };
        }
        return task;
      });
      checkpoint.status = "failed";
      checkpoint.resumeCount = nextResumeCount;
      checkpoint.lastUpdated = new Date().toISOString();
      saveCheckpoint(checkpoint, workdir);
      return checkpoint;
    }

    checkpoint.tasks = checkpoint.tasks.map((task) => {
      if (!resumableIds.has(task.id)) return task;
      // Strip prior attempt state so the task restarts cleanly.
      return {
        id: task.id,
        status: "pending" as TaskStatus,
      };
    });

    // Drop dead session references for reset tasks so resume starts fresh.
    if (checkpoint.sessions) {
      const nextSessions: typeof checkpoint.sessions = {};
      for (const [taskId, session] of Object.entries(checkpoint.sessions)) {
        if (!resumableIds.has(taskId)) {
          nextSessions[taskId] = session;
        }
      }
      checkpoint.sessions = nextSessions;
    }

    checkpoint.resumeCount = nextResumeCount;
    checkpoint.lastUpdated = new Date().toISOString();
    saveCheckpoint(checkpoint, workdir);
    console.log(
      `[checkpoint] Auto-recovered stale checkpoint ${checkpoint.runId} ` +
        `(reset ${resumableIds.size} task(s) to pending, resumeCount=${nextResumeCount})`,
    );
    return checkpoint;
  }

  // No in-progress/in-review tasks. Decide state carefully:
  //   - all completed + reviewPassed  → complete
  //   - any task explicitly failed    → failed
  //   - otherwise (all pending, or mix of pending + completed) → leave as
  //     "running" so the next harness.execute can resume it. This case covers
  //     both fresh checkpoints and ones that reconcile already repaired.
  const allCompleted = checkpoint.tasks.every(
    (task) => task.status === "completed" && task.reviewPassed,
  );
  const anyFailed = checkpoint.tasks.some((task) => task.status === "failed");

  if (allCompleted) {
    checkpoint.status = "complete";
    checkpoint.lastUpdated = new Date().toISOString();
    saveCheckpoint(checkpoint, workdir);
  } else if (anyFailed) {
    checkpoint.status = "failed";
    checkpoint.lastUpdated = new Date().toISOString();
    saveCheckpoint(checkpoint, workdir);
  }
  // else: leave checkpoint untouched — still resumable running.
  return checkpoint;
}

export function findRecoverableCheckpoint(request: string, workdir: string): CheckpointData | null {
  const checkpointsRoot = join("/tmp", "harness");
  const normalizedWorkdir = normalizeWorkdirPath(workdir);

  try {
    if (!existsSync(checkpointsRoot)) return null;

    const matches = readdirSync(checkpointsRoot)
      .map((runId) => join(checkpointsRoot, runId, "checkpoint.json"))
      .filter((path) => existsSync(path))
      .map((path) => {
        try {
          const raw = readFileSync(path, "utf-8");
          const parsed = JSON.parse(raw) as CheckpointData;
          return reconcileStaleCheckpoint(parsed, workdir);
        } catch {
          return null;
        }
      })
      .filter((checkpoint): checkpoint is CheckpointData => checkpoint !== null)
      .filter((checkpoint) => checkpoint.status === "running")
      .filter((checkpoint) => checkpoint.plan?.originalRequest === request)
      .filter((checkpoint) => normalizeWorkdirPath(checkpoint.workdir ?? "") === normalizedWorkdir || normalizeWorkdirPath(checkpoint.executionWorkdir ?? "") === normalizedWorkdir)
      .filter(
        (checkpoint) =>
          checkpoint.tasks.some((task) => task.status !== "pending") ||
          Object.keys(checkpoint.sessions ?? {}).length > 0 ||
          (checkpoint.resumeCount ?? 0) > 0,
      )
      .sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated));

    return matches[0] ?? null;
  } catch (err: any) {
    console.warn(`[checkpoint] Failed to search recoverable checkpoints: ${err?.message ?? String(err)}`);
    return null;
  }
}

// ── Stale plan cleanup ──

const STALE_PLANNING_MS = 30 * 60 * 1000;          // 30 min for stuck "running" with no activity
const STALE_CHECKPOINT_MS = 24 * 60 * 60 * 1000;   // 24 hours — keep checkpoints visible for dashboard
const STALE_WORKSPACE_MS = 60 * 60 * 1000;          // 1 hour — clean up 20GB+ workspace clones early

/**
 * Remove stale checkpoint directories.
 * Called periodically from the plugin GC interval.
 *
 * - "running" plans older than 30 min with no recent activity → removed
 * - Terminal plans ("complete"/"failed"/"escalated"/"aborted") older than 1 hour → removed
 */
export function cleanupStaleCheckpoints(): { removed: number; errors: number } {
  const checkpointsRoot = join("/tmp", "harness");
  if (!existsSync(checkpointsRoot)) return { removed: 0, errors: 0 };

  const now = Date.now();
  let removed = 0;
  let errors = 0;

  try {
    for (const dirName of readdirSync(checkpointsRoot)) {
      const dirPath = join(checkpointsRoot, dirName);
      const cpPath = join(dirPath, "checkpoint.json");
      if (!existsSync(cpPath)) continue;

      try {
        let cp = JSON.parse(readFileSync(cpPath, "utf-8")) as CheckpointData;
        const lastUpdated = Date.parse(cp.lastUpdated || "");
        if (isNaN(lastUpdated)) continue;

        // For stuck "running" plans where the worker/reviewer processes have
        // died, run reconcile first. This either bumps the checkpoint into a
        // terminal state (so normal cleanup applies) or auto-recovers it by
        // resetting in-progress tasks to pending. The recovered checkpoint
        // then survives cleanup until the next harness.execute resumes it.
        if (cp.status === "running") {
          const reconcileWorkdir = cp.workdir || cp.executionWorkdir || "";
          const before = { status: cp.status, resumeCount: cp.resumeCount ?? 0 };
          cp = reconcileStaleCheckpoint(cp, reconcileWorkdir);
          if (
            cp.status !== before.status ||
            (cp.resumeCount ?? 0) !== before.resumeCount
          ) {
            console.log(
              `[checkpoint] Cleanup reconciled ${cp.runId}: ` +
                `status ${before.status}→${cp.status}, ` +
                `resumeCount ${before.resumeCount}→${cp.resumeCount ?? 0}`,
            );
          }
        }

        const reconciledLastUpdated = Date.parse(cp.lastUpdated || "");
        const age = Number.isNaN(reconciledLastUpdated)
          ? now - lastUpdated
          : now - reconciledLastUpdated;
        const isTerminal = cp.status === "complete" || cp.status === "failed"
          || cp.status === "escalated" || (cp.status as string) === "aborted";

        // For "running" plans, also check the checkpoint file's filesystem mtime.
        // The heartbeat loop doesn't update lastUpdated in the JSON, but
        // saveCheckpoint() touches the file. If the file was written recently
        // (within STALE_PLANNING_MS), the plan is still actively running.
        let fileAge = age;
        if (cp.status === "running") {
          try {
            const fileStat = statSync(cpPath);
            fileAge = Math.min(age, now - fileStat.mtimeMs);
          } catch { /* use JSON age */ }
        }

        // Workspace clones (20GB+): clean aggressively for terminal plans.
        // For "running" plans, only clean workspace if reconcile could not
        // recover them (should not happen — reconcile either terminates or
        // resets to pending + running). Guard with STALE_PLANNING_MS anyway.
        const shouldCleanWorkspace = isTerminal
          ? age > STALE_WORKSPACE_MS
          : cp.status === "running" && fileAge > STALE_PLANNING_MS;

        if (shouldCleanWorkspace) {
          cleanupWorkspaceForPlan(dirName);
        }

        // Checkpoints (small JSON): keep 24 hours for terminal plans.
        // Running plans are preserved as long as reconcile keeps them alive;
        // they only get removed once reconcile turns them terminal.
        const shouldRemoveCheckpoint = isTerminal && age > STALE_CHECKPOINT_MS;

        if (shouldRemoveCheckpoint) {
          rmSync(dirPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        errors++;
      }
    }
  } catch {
    // root dir read failure
  }

  if (removed > 0) {
    console.log(`[checkpoint] Stale cleanup: removed ${removed} plan(s), errors ${errors}`);
  }

  // Also sweep orphaned workspace dirs that have no matching checkpoint
  cleanupOrphanedWorkspaces(now);

  return { removed, errors };
}

const WORKSPACE_ROOT = join(homedir(), ".openclaw", "harness-execution-workspaces");

/**
 * Remove the execution workspace and isolation state for a given plan.
 * Called when a stale checkpoint is cleaned up.
 */
function cleanupWorkspaceForPlan(planId: string): void {
  // Isolation state: ~/.openclaw/harness-execution-workspaces/state/{planId}.json
  const statePath = join(WORKSPACE_ROOT, "state", `${planId}.json`);
  try {
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const cleanupRoot = state?.cleanupRoot ?? state?.executionWorkdir;
      if (cleanupRoot && existsSync(cleanupRoot)) {
        rmSync(cleanupRoot, { recursive: true, force: true });
        console.log(`[checkpoint] Cleaned workspace: ${cleanupRoot}`);
      }
      rmSync(statePath, { force: true });
    }
  } catch { /* best-effort */ }

  // Also try to find workspace dir by planId prefix pattern
  try {
    if (existsSync(WORKSPACE_ROOT)) {
      for (const entry of readdirSync(WORKSPACE_ROOT)) {
        if (entry === "state") continue;
        if (entry.startsWith(planId)) {
          const wsPath = join(WORKSPACE_ROOT, entry);
          rmSync(wsPath, { recursive: true, force: true });
          console.log(`[checkpoint] Cleaned workspace dir: ${wsPath}`);
        }
      }
    }
  } catch { /* best-effort */ }
}

/**
 * Remove orphaned workspace dirs that have no matching checkpoint.
 * Catches workspaces left behind by crashed runs where the checkpoint
 * was already deleted but the 20GB+ workspace clone was not.
 */
function cleanupOrphanedWorkspaces(now: number): void {
  if (!existsSync(WORKSPACE_ROOT)) return;

  const checkpointsRoot = join("/tmp", "harness");
  const activePlanIds = new Set<string>();
  try {
    if (existsSync(checkpointsRoot)) {
      for (const dirName of readdirSync(checkpointsRoot)) {
        activePlanIds.add(dirName);
      }
    }
  } catch { /* ignore */ }

  try {
    for (const entry of readdirSync(WORKSPACE_ROOT)) {
      if (entry === "state") continue;
      // Entry format: plan-YYYYMMDD-XXXXXX-RANDOM
      const planIdMatch = entry.match(/^(plan-\d{8}-[a-z0-9]+)/);
      if (!planIdMatch) continue;

      const planId = planIdMatch[1];
      if (activePlanIds.has(planId)) continue; // checkpoint still exists

      const wsPath = join(WORKSPACE_ROOT, entry);
      try {
        const stat = statSync(wsPath);
        const age = now - stat.mtimeMs;
        if (age > STALE_COMPLETE_MS) {
          rmSync(wsPath, { recursive: true, force: true });
          console.log(`[checkpoint] Cleaned orphaned workspace: ${wsPath} (age ${Math.round(age / 60000)}min)`);
          // Also clean state file
          const statePath = join(WORKSPACE_ROOT, "state", `${planId}.json`);
          rmSync(statePath, { force: true });
        }
      } catch { /* best-effort */ }
    }
  } catch { /* ignore */ }
}

