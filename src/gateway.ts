import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { getSessionManager, pluginConfig, formatSessionListing, formatDuration, formatStats, resolveOriginChannel } from "./shared";
import { findRecoverableCheckpoint, saveCheckpoint } from "./checkpoint";
import type { CheckpointData } from "./types";

// Lazy reference to the harness_execute tool factory. Set during registerGatewayMethods
// so the gateway method can invoke the tool directly without going through an agent.
let harnessExecuteFactory: ((ctx: any) => any) | null = null;

// In-flight dedup: tracks running harness.execute background tasks by request hash.
// Prevents duplicate execution when the gateway CLI retries after a pipe signal.
const inFlightExecutions = new Map<string, { startedAt: number; planId?: string }>();

function executionKey(request: string, workdir: string): string {
  return createHash("sha256").update(`${request}|${workdir}`).digest("hex").slice(0, 16);
}

export function setHarnessExecuteFactory(factory: (ctx: any) => any): void {
  harnessExecuteFactory = factory;
}

/**
 * Gateway RPC methods
 *
 * Methods:
 *   claude-code.sessions — list sessions
 *   claude-code.launch   — launch a new session
 *   claude-code.kill     — kill a running session
 *   claude-code.output   — get output from a session
 *   claude-code.stats    — return aggregated metrics
 *   harness.execute      — invoke harness_execute directly (bypasses agent layer)
 */
export function registerGatewayMethods(api: any): void {

  // ── harness.execute — direct tool invocation ───────────────────
  // Bypasses the agent layer entirely. Useful when the orchestrator
  // model (gpt-5.4) fails to reliably call the MCP tool.
  api.registerGatewayMethod("harness.execute", ({ respond, params }: any) => {
    if (!harnessExecuteFactory) {
      return respond(false, { error: "harness_execute factory not registered" });
    }
    if (!params?.request) {
      return respond(false, { error: "Missing required parameter: request" });
    }

    // agentId must be a real OpenClaw agent (not "gateway") — cc-plan-review.sh
    // uses it as the review agent target for `openclaw agent -m`. "gateway" is
    // not a real agent and produces empty responses, causing plan review to fail.
    // Default to the OPENCLAW_NOTIFY_AGENT_DEFAULT env or "nova".
    const resolvedAgentId = params.agentId && params.agentId !== "gateway"
      ? params.agentId
      : process.env.OPENCLAW_NOTIFY_AGENT_DEFAULT || "nova";

    const ctx = {
      agentId: resolvedAgentId,
      workspaceDir: params.workdir ?? pluginConfig.defaultWorkdir ?? process.cwd(),
      messageChannel: params.channel ?? pluginConfig.fallbackChannel,
    };

    // Dedup guard: reject if the same request+workdir is already running in background.
    // This prevents duplicate execution when the CLI retries after a pipe signal (exit 144).
    const dedupKey = executionKey(params.request, ctx.workspaceDir);
    const existing = inFlightExecutions.get(dedupKey);
    if (existing) {
      const elapsedMin = Math.round((Date.now() - existing.startedAt) / 60000);
      console.log(`[harness.execute] Duplicate request rejected (key=${dedupKey}, running for ${elapsedMin}min, plan=${existing.planId ?? "?"})`);
      return respond(true, {
        status: "already_running",
        message: `Harness execution already in progress (${elapsedMin}min). Use harness.kill to stop it first.`,
        planId: existing.planId,
      });
    }

    inFlightExecutions.set(dedupKey, { startedAt: Date.now() });

    // Respond IMMEDIATELY — the entire pipeline (including planner) runs
    // in background. This prevents WebSocket timeout on long planner calls.
    respond(true, { status: "accepted", message: "Harness execution started. Results will be pushed to channel." });

    void (async () => {
      try {
        const tool = harnessExecuteFactory(ctx);
        await tool.execute("gateway-rpc", {
          request: params.request,
          workdir: params.workdir,
          tier_override: params.tier_override,
          max_budget_usd: params.max_budget_usd,
          reviewOnly: params.reviewOnly,
        });
      } catch (err: any) {
        console.error(`[harness.execute] Gateway RPC background error: ${err?.message ?? String(err)}`);
      } finally {
        inFlightExecutions.delete(dedupKey);
      }
    })();
  });

  // ── harness.kill — abort a running harness plan ─────────────────
  // Finds the running checkpoint for the given planId, kills the remote
  // worker process tree (via SSH), writes "ABORT" to the feedback file,
  // and marks the checkpoint as failed. Callable via:
  //   openclaw gateway call harness.kill --params '{"planId":"plan-..."}'
  api.registerGatewayMethod("harness.kill", ({ respond, params }: any) => {
    const planId = params?.planId as string | undefined;
    if (!planId) {
      return respond(false, { error: "Missing required parameter: planId" });
    }

    const checkpointDir = join("/tmp", "harness", planId);
    const cpPath = join(checkpointDir, "checkpoint.json");
    if (!existsSync(cpPath)) {
      return respond(false, { error: `Checkpoint not found: ${planId}` });
    }

    try {
      const cp: CheckpointData = JSON.parse(readFileSync(cpPath, "utf-8"));

      // Find and signal live worker processes via shared-state files
      const stateRoot = join("/tmp", "claude-realtime");
      const killedJobs: string[] = [];
      for (const [, session] of Object.entries(cp.sessions ?? {})) {
        const jobId = session.worker;
        if (!jobId) continue;
        const stateDir = join(stateRoot, jobId);
        try { writeFileSync(join(stateDir, "feedback"), "ABORT\n", "utf8"); } catch {}
        try { writeFileSync(join(stateDir, "status"), "aborted\n", "utf8"); } catch {}
        try {
          const pidStr = readFileSync(join(stateDir, "pid"), "utf8").trim();
          const pid = parseInt(pidStr, 10);
          if (pid > 0) {
            process.kill(pid, "SIGTERM");
            killedJobs.push(`${jobId} (local pid ${pid})`);
            continue;
          }
        } catch {}
        killedJobs.push(jobId);
      }

      // Mark checkpoint as failed
      cp.status = "failed";
      cp.tasks = cp.tasks.map((t) => {
        if (t.status === "in-progress" || t.status === "in-review") {
          return { ...t, status: "failed", reviewPassed: false };
        }
        return t;
      });
      cp.lastUpdated = new Date().toISOString();
      saveCheckpoint(cp, cp.workdir ?? "");

      // Respond immediately — the hard pkill sweep runs in the background so
      // the caller doesn't block on SSH round-trips.
      respond(true, {
        planId,
        status: "killed",
        killedJobs,
        message: `Plan ${planId} aborted. ${killedJobs.length} job(s) signaled. Remote pkill sweeping in background.`,
      });

      // Background: hard-kill remote worker processes + local review scripts.
      // Remote worker PID suffixes are millisecond timestamps, not PIDs, so
      // local kill(pid, 0) can't reach them. Pattern-match on the jobId
      // prefix via SSH pkill to terminate the entire worker tree (bash
      // wrapper + claude CLI + any tee/monitor helpers).
      void (async () => {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const remoteHost = process.env.OPENCLAW_REALTIME_REMOTE_HOST || "hetzner-build";
        // planId already starts with "plan-" (e.g. "plan-20260414-y0budf").
        // Worker jobIds are shaped "harness-${planId}-task-N-<ts>", so the
        // match pattern is just ${planId} — prepending another "harness-plan-"
        // would produce "harness-plan-plan-..." and never match.
        const pattern = planId;

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // Phase 1 — SIGTERM sweep (graceful).
        // Remote worker tree on Hetzner.
        try {
          await execFileAsync("ssh", [
            "-o", "ConnectTimeout=8",
            "-o", "BatchMode=yes",
            remoteHost,
            // `exit 0` so pgrep-no-match doesn't surface as SSH exit 1
            `pkill -TERM -f '${pattern}' 2>/dev/null; exit 0`,
          ], { timeout: 15000 });
          console.log(`[harness.kill] Remote pkill -TERM on ${remoteHost} for ${pattern}`);
        } catch (err: any) {
          console.warn(`[harness.kill] Remote pkill -TERM failed (non-fatal): ${err?.message ?? err}`);
        }
        // Local review wrappers (cc-*-review.sh, codex children, ssh clients
        // that args-match the pattern).
        try {
          await execFileAsync("pkill", ["-TERM", "-f", pattern], { timeout: 5000 });
          console.log(`[harness.kill] Local pkill -TERM for ${pattern}`);
        } catch { /* no match is fine */ }

        // Give TERM handlers 2 seconds to clean up.
        await sleep(2000);

        // Phase 2 — SIGKILL for anything that ignored TERM.
        // Catches: ssh clients stuck in uninterruptible state, claude CLI mid
        // request, any child that doesn't honor SIGTERM promptly.
        try {
          await execFileAsync("ssh", [
            "-o", "ConnectTimeout=8",
            "-o", "BatchMode=yes",
            remoteHost,
            `pkill -9 -f '${pattern}' 2>/dev/null; exit 0`,
          ], { timeout: 15000 });
          console.log(`[harness.kill] Remote pkill -9 sweep on ${remoteHost}`);
        } catch (err: any) {
          console.warn(`[harness.kill] Remote pkill -9 failed (non-fatal): ${err?.message ?? err}`);
        }
        try {
          await execFileAsync("pkill", ["-9", "-f", pattern], { timeout: 5000 });
          console.log(`[harness.kill] Local pkill -9 sweep for ${pattern}`);
        } catch { /* no match is fine */ }
      })();
    } catch (err: any) {
      respond(false, { error: `Failed to kill plan: ${err?.message ?? String(err)}` });
    }
  });

  // ── claude-code.sessions ────────────────────────────────────────
  api.registerGatewayMethod("claude-code.sessions", ({ respond, params }: any) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const filter = params?.status ?? "all";
    const sessions = sessionManager.list(filter);

    const result = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      prompt: s.prompt,
      workdir: s.workdir,
      model: s.model,
      costUsd: s.costUsd,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationMs: s.duration,
      claudeSessionId: s.claudeSessionId,
      foreground: s.foregroundChannels.size > 0,
      multiTurn: s.multiTurn,
      // Also include human-readable listing
      display: formatSessionListing(s),
    }));

    respond(true, { sessions: result, count: result.length });
  });

  // ── claude-code.launch ──────────────────────────────────────────
  api.registerGatewayMethod("claude-code.launch", ({ respond, params }: any) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    if (!params?.prompt) {
      return respond(false, { error: "Missing required parameter: prompt" });
    }

    try {
      const session = sessionManager.spawn({
        prompt: params.prompt,
        name: params.name,
        workdir: params.workdir || pluginConfig.defaultWorkdir || process.cwd(),
        model: params.model || pluginConfig.defaultModel,
        maxBudgetUsd: params.maxBudgetUsd ?? params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5,
        systemPrompt: params.systemPrompt ?? params.system_prompt,
        allowedTools: params.allowedTools ?? params.allowed_tools,
        resumeSessionId: params.resumeSessionId ?? params.resume_session_id,
        forkSession: params.forkSession ?? params.fork_session,
        multiTurn: !(params.multiTurnDisabled ?? params.multi_turn_disabled),
        originChannel: params.originChannel ?? "gateway",
      });

      respond(true, {
        id: session.id,
        name: session.name,
        status: session.status,
        workdir: session.workdir,
        model: session.model,
      });
    } catch (err: any) {
      respond(false, { error: err.message });
    }
  });

  // ── claude-code.kill ────────────────────────────────────────────
  api.registerGatewayMethod("claude-code.kill", ({ respond, params }: any) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const ref = params?.session ?? params?.id;
    if (!ref) {
      return respond(false, { error: "Missing required parameter: session (name or ID)" });
    }

    const session = sessionManager.resolve(ref);
    if (!session) {
      return respond(false, { error: `Session "${ref}" not found` });
    }

    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return respond(true, {
        id: session.id,
        name: session.name,
        status: session.status,
        message: `Session already ${session.status}`,
      });
    }

    sessionManager.kill(session.id);

    respond(true, {
      id: session.id,
      name: session.name,
      status: "killed",
      message: `Session ${session.name} [${session.id}] terminated`,
    });
  });

  // ── claude-code.output ──────────────────────────────────────────
  api.registerGatewayMethod("claude-code.output", ({ respond, params }: any) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const ref = params?.session ?? params?.id;
    if (!ref) {
      return respond(false, { error: "Missing required parameter: session (name or ID)" });
    }

    const session = sessionManager.resolve(ref);
    if (!session) {
      return respond(false, { error: `Session "${ref}" not found` });
    }

    const lines = params?.full
      ? session.getOutput()
      : session.getOutput(params?.lines ?? 50);

    respond(true, {
      id: session.id,
      name: session.name,
      status: session.status,
      costUsd: session.costUsd,
      durationMs: session.duration,
      duration: formatDuration(session.duration),
      lines,
      lineCount: lines.length,
      result: session.result ?? null,
    });
  });

  // ── claude-code.stats ───────────────────────────────────────────
  api.registerGatewayMethod("claude-code.stats", ({ respond, params }: any) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const metrics = sessionManager.getMetrics();

    // Build a serializable version (Map → Object)
    const costPerDay: Record<string, number> = {};
    for (const [key, val] of metrics.costPerDay) {
      costPerDay[key] = val;
    }

    const running = sessionManager.list("running").length;

    respond(true, {
      totalCostUsd: metrics.totalCostUsd,
      costPerDay,
      sessionsByStatus: {
        ...metrics.sessionsByStatus,
        running,
      },
      totalLaunched: metrics.totalLaunched,
      averageDurationMs: metrics.sessionsWithDuration > 0
        ? metrics.totalDurationMs / metrics.sessionsWithDuration
        : 0,
      mostExpensive: metrics.mostExpensive,
      // Human-readable version too
      display: formatStats(metrics),
    });
  });
}
