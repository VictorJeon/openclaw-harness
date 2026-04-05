import type { WorkerBackendHandler } from "./types";

export const localCcBackend: WorkerBackendHandler = {
  name: "local-cc",
  available() {
    return false;
  },
  describe() {
    return "Future opt-in local Claude Code backend (phase-1 placeholder).";
  },
};

// TODO: Phase 2/3 should replace this placeholder with the real local Claude Code worker path.
