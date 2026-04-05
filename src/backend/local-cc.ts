import type { WorkerBackendHandler, WorkerExecutionResult } from "./types";

const NOT_IMPLEMENTED_MESSAGE =
  'local-cc worker backend is not yet implemented. Set workerBackend="remote-realtime" or wait for phase 3.';

export const localCcBackend: WorkerBackendHandler = {
  name: "local-cc",
  available() {
    return false;
  },
  describe() {
    return "Future opt-in local Claude Code backend (phase-2 stub — not yet implemented).";
  },

  async executeWorker(): Promise<WorkerExecutionResult> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  },

  async continueWorker(): Promise<WorkerExecutionResult> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  },

  async finalizeWorker(): Promise<WorkerExecutionResult> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  },
};
