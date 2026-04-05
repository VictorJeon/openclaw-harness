import type { WorkerBackend } from "../types";

export interface WorkerBackendHandler {
  name: WorkerBackend;
  available(): boolean;
  describe(): string;
}
