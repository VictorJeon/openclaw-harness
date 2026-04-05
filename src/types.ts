// SDK types are imported from "@anthropic-ai/claude-agent-sdk"
// We define our own types for the plugin's internal state

/**
 * Context provided by OpenClaw's tool factory pattern.
 * When registerTool receives a factory function instead of a static tool object,
 * it calls the factory with this context, giving each tool access to the
 * calling agent's runtime information.
 */
export interface OpenClawPluginToolContext {
  config?: Record<string, any>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
}

export type SessionStatus = "starting" | "running" | "completed" | "failed" | "killed";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export type WorkerBackend = "remote-realtime" | "local-cc";

export interface SessionConfig {
  prompt: string;
  workdir: string;
  name?: string;
  model?: string;
  maxBudgetUsd: number;
  internal?: boolean;
  foreground?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;  // Channel that spawned this session (for background notifications)
  deliverChannel?: string; // Channel for --deliver args in wakeAgent() (resolved from launching agent's workspace)
  originAgentId?: string;  // Agent ID that launched this session (for targeted wake events)
  permissionMode?: PermissionMode;

  // Resume/fork support (Task 16)
  resumeSessionId?: string;  // Claude session ID to resume
  forkSession?: boolean;     // Fork instead of continuing when resuming

  // Multi-turn support (Task 15)
  multiTurn?: boolean;  // If true, use AsyncIterable prompt for multi-turn conversations
}

export interface ClaudeSession {
  id: string;                    // nanoid(8)
  name: string;                  // human-readable kebab-case name
  claudeSessionId?: string;      // UUID from SDK init message

  // Configuration
  prompt: string;
  workdir: string;
  model?: string;
  maxBudgetUsd: number;

  // State
  status: SessionStatus;
  error?: string;

  // Timing
  startedAt: number;
  completedAt?: number;

  // Output
  outputBuffer: string[];        // Last N lines of assistant text

  // Result from SDK
  result?: {
    subtype: string;
    duration_ms: number;
    total_cost_usd: number;
    num_turns: number;
    result?: string;
    is_error: boolean;
    session_id: string;
  };

  // Cost tracking
  costUsd: number;

  // Foreground channels
  foregroundChannels: Set<string>;
}

export interface PluginConfig {
  maxSessions: number;
  defaultBudgetUsd: number;
  defaultModel?: string;
  defaultWorkdir?: string;
  idleTimeoutMinutes: number;
  maxPersistedSessions: number;
  fallbackChannel?: string;
  permissionMode?: PermissionMode;
  agentChannels?: Record<string, string>;
  maxAutoResponds: number;
  skipSafetyChecks?: boolean;

  // Harness-specific config
  operationMode: OperationMode;
  maxReviewLoops: number;
  reviewModel?: string;
  plannerModel?: string;
  realtimeModel?: string;
  workerModel?: string;      // legacy fallback alias for realtimeModel
  workerBackend: WorkerBackend;
  memoryV3Endpoint?: string;
  routerMaxTokens: number;
  plannerMaxTokens: number;
  reviewerMaxTokens: number;
}

// --- Harness types ---

export type OperationMode = "ask" | "delegate" | "autonomous";

export type Tier = 0 | 1 | 2;

export type GapType =
  | "assumption_injection"
  | "scope_creep"
  | "direction_drift"
  | "missing_core"
  | "over_engineering";

export type TaskStatus = "pending" | "in-progress" | "completed" | "in-review" | "failed";

export interface TaskSpec {
  id: string;
  title: string;
  scope: string;
  acceptanceCriteria: string[];
  agent: "codex" | "claude";
}

export interface PlannerMetadata {
  /** Which planner backend produced this plan: "model" or "heuristic" */
  backend: "model" | "heuristic";
  /** Model used for planning (undefined for heuristic) */
  model?: string;
  /** Whether the planner fell back from a higher-tier attempt */
  fallback: boolean;
  /** If fallback happened, the reason */
  fallbackReason?: string;
}

export interface HarnessPlan {
  id: string;
  originalRequest: string;
  tasks: TaskSpec[];
  mode: "solo" | "parallel" | "sequential";
  estimatedComplexity: "low" | "medium" | "high";
  tier: Tier;
  plannerMetadata?: PlannerMetadata;
}

export interface WorkerResult {
  taskId: string;
  status: "completed" | "failed";
  summary: string;
  filesChanged: string[];
  testsRun: number;
  warnings: string[];
  sessionId?: string;
}

export interface ReviewGap {
  type: GapType;
  evidence: string;
  fixHint: string;
}

export interface ReviewResult {
  taskId: string;
  result: "pass" | "fail";
  gaps: ReviewGap[];
  rerunNeeded: boolean;
}

export interface CheckpointData {
  runId: string;
  status: "running" | "complete" | "failed" | "escalated";
  plan: HarnessPlan;
  tasks: Array<{
    id: string;
    status: TaskStatus;
    reviewPassed?: boolean;
    reviewLoop?: number;
    workerResult?: WorkerResult;
    reviewResult?: ReviewResult;
  }>;
  sessions: Record<string, { worker?: string; reviewer?: string }>;
  lastUpdated: string;
}

export interface HarnessRunResult {
  runId: string;
  status: "success" | "partial" | "failed" | "escalated";
  plan: HarnessPlan;
  tasks: Array<{
    id: string;
    status: TaskStatus;
    workerResult?: WorkerResult;
    reviewResult?: ReviewResult;
  }>;
  summary: string;
  totalReviewLoops: number;
  escalationReason?: string;
}
