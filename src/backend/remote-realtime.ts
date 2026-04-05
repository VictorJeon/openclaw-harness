import type { WorkerBackendHandler } from "./types";

export const remoteRealtimeBackend: WorkerBackendHandler = {
  name: "remote-realtime",
  available() {
    return true;
  },
  describe() {
    return "Current stable lane: remote Claude realtime worker on Hetzner.";
  },
};
