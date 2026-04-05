import type { PluginConfig, WorkerBackend } from "../types";
import { localCcBackend } from "./local-cc";
import { remoteRealtimeBackend } from "./remote-realtime";
import type { WorkerBackendHandler } from "./types";

const BACKENDS: Record<WorkerBackend, WorkerBackendHandler> = {
  "remote-realtime": remoteRealtimeBackend,
  "local-cc": localCcBackend,
};

export function resolveWorkerBackend(config: Pick<PluginConfig, "workerBackend">): WorkerBackendHandler {
  const selected = config.workerBackend ?? "remote-realtime";
  return BACKENDS[selected] ?? remoteRealtimeBackend;
}
