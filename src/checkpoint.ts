import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { CheckpointData, HarnessPlan, TaskStatus, WorkerResult, ReviewResult } from "./types";

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
    workdir: resolve(workdir),
    executionWorkdir: resolve(executionWorkdir),
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

export function findRecoverableCheckpoint(request: string, workdir: string): CheckpointData | null {
  const checkpointsRoot = join("/tmp", "harness");
  const normalizedWorkdir = resolve(workdir);

  try {
    if (!existsSync(checkpointsRoot)) return null;

    const matches = readdirSync(checkpointsRoot)
      .map((runId) => join(checkpointsRoot, runId, "checkpoint.json"))
      .filter((path) => existsSync(path))
      .map((path) => {
        try {
          const raw = readFileSync(path, "utf-8");
          return JSON.parse(raw) as CheckpointData;
        } catch {
          return null;
        }
      })
      .filter((checkpoint): checkpoint is CheckpointData => checkpoint !== null)
      .filter((checkpoint) => checkpoint.status === "running")
      .filter((checkpoint) => checkpoint.plan?.originalRequest === request)
      .filter((checkpoint) => checkpoint.workdir === normalizedWorkdir || checkpoint.executionWorkdir === normalizedWorkdir)
      .filter((checkpoint) => checkpoint.tasks.some((task) => task.status !== "pending") || Object.keys(checkpoint.sessions ?? {}).length > 0)
      .sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated));

    return matches[0] ?? null;
  } catch (err: any) {
    console.warn(`[checkpoint] Failed to search recoverable checkpoints: ${err?.message ?? String(err)}`);
    return null;
  }
}

