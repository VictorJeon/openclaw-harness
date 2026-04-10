import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { kill } from "process";
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

function reconcileStaleCheckpoint(checkpoint: CheckpointData, workdir: string): CheckpointData {
  if (checkpoint.status !== "running") return checkpoint;
  if (checkpointHasLiveSession(checkpoint)) return checkpoint;

  const hasFailed = checkpoint.tasks.some((task) => task.status === "failed");
  const hasCompleted = checkpoint.tasks.some((task) => task.status === "completed");
  const hasReviewPending = checkpoint.tasks.some((task) => task.status === "in-review");
  const hasWorkInProgress = checkpoint.tasks.some((task) => task.status === "in-progress");

  if (hasReviewPending || hasWorkInProgress) {
    checkpoint.tasks = checkpoint.tasks.map((task) => {
      if (task.status === "in-review" || task.status === "in-progress") {
        return { ...task, status: "failed", reviewPassed: false };
      }
      return task;
    });
  }

  if (checkpoint.tasks.every((task) => task.status === "completed" && task.reviewPassed)) {
    checkpoint.status = "complete";
  } else if (hasFailed || hasCompleted || hasReviewPending || hasWorkInProgress) {
    checkpoint.status = "failed";
  } else {
    checkpoint.status = "failed";
  }
  checkpoint.lastUpdated = new Date().toISOString();
  saveCheckpoint(checkpoint, workdir);
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
      .filter((checkpoint) => checkpoint.tasks.some((task) => task.status !== "pending") || Object.keys(checkpoint.sessions ?? {}).length > 0)
      .sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated));

    return matches[0] ?? null;
  } catch (err: any) {
    console.warn(`[checkpoint] Failed to search recoverable checkpoints: ${err?.message ?? String(err)}`);
    return null;
  }
}

// ── Stale plan cleanup ──

const STALE_PLANNING_MS = 30 * 60 * 1000;   // 30 min for stuck "running"
const STALE_COMPLETE_MS = 60 * 60 * 1000;   // 1 hour for terminal states

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
        const cp = JSON.parse(readFileSync(cpPath, "utf-8")) as CheckpointData;
        const lastUpdated = Date.parse(cp.lastUpdated || "");
        if (isNaN(lastUpdated)) continue;

        const age = now - lastUpdated;
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

        const shouldRemove = isTerminal
          ? age > STALE_COMPLETE_MS
          : cp.status === "running" && fileAge > STALE_PLANNING_MS;

        if (shouldRemove) {
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

  return { removed, errors };
}

