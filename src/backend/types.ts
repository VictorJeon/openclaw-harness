import type {
  WorkerBackend,
  TaskSpec,
  HarnessPlan,
  OpenClawPluginToolContext,
} from "../types";

/**
 * Result shape returned by worker backend execution methods.
 * Mirrors the RealtimeExecutionResult used internally by the realtime path.
 */
export interface WorkerExecutionResult {
  jobId: string;
  stateDir: string;
  output: string;
  status: string;
  workerResult: import("../types").WorkerResult | null;
  error?: string;
  /** User-visible detail string for surfacing stuck/timeout conditions. */
  errorDetail?: string;
}

/**
 * Context bundle passed to worker backend execution methods.
 * Aggregates the parameters that executeTask currently passes inline.
 */
export interface WorkerExecutionContext {
  task: TaskSpec;
  plan: HarnessPlan;
  workdir: string;
  ctx: OpenClawPluginToolContext;
  workerModel: string;
  workerEffort?: import("../types").ClaudeEffortLevel;
  jobId: string;
}

export interface WorkerBackendHandler {
  name: WorkerBackend;
  available(): boolean;
  describe(): string;

  /** Launch a worker for the given task. Phase-2 dispatch entry point. */
  executeWorker(context: WorkerExecutionContext): Promise<WorkerExecutionResult>;

  /** Send fix feedback to an in-progress worker and wait for next checkpoint. */
  continueWorker(context: WorkerExecutionContext, feedback: string): Promise<WorkerExecutionResult>;

  /** Signal the worker that review passed and wait for terminal state. */
  finalizeWorker(context: WorkerExecutionContext): Promise<WorkerExecutionResult>;
}
