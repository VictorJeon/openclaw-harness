import type { WorkerBackendHandler, WorkerExecutionContext, WorkerExecutionResult } from "./types";
import {
  executeRealtimeTask,
  continueRealtimeTask,
  finalizeRealtimeTask,
} from "../tools/harness-execute";

export const remoteRealtimeBackend: WorkerBackendHandler = {
  name: "remote-realtime",
  available() {
    return true;
  },
  describe() {
    return "Current stable lane: remote Claude realtime worker on Hetzner.";
  },

  async executeWorker(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    return executeRealtimeTask(
      context.task,
      context.plan,
      context.workdir,
      context.ctx,
      context.workerModel,
      context.jobId,
    );
  },

  async continueWorker(context: WorkerExecutionContext, feedback: string): Promise<WorkerExecutionResult> {
    return continueRealtimeTask(
      context.task,
      context.plan,
      context.workdir,
      context.ctx,
      context.jobId,
      feedback,
    );
  },

  async finalizeWorker(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    return finalizeRealtimeTask(
      context.task,
      context.plan,
      context.workdir,
      context.ctx,
      context.jobId,
    );
  },
};
