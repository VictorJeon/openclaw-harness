const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { basename, join, resolve } = require("node:path");
const esbuild = require("esbuild");

const ROOT = resolve(__dirname, "..");

function loadTsModule(relativePath) {
  const entry = resolve(ROOT, relativePath);
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-harness-test-"));
  const outfile = join(tempDir, basename(relativePath).replace(/\.ts$/, ".cjs"));
  symlinkSync(resolve(ROOT, "node_modules"), join(tempDir, "node_modules"), "dir");

  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["@anthropic-ai/claude-agent-sdk"],
    logLevel: "silent",
  });

  const mod = require(outfile);
  return {
    mod,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function testPlannerIgnoresReturnBullets() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const request = `Need the next harness fixes before resuming optimizer validation:

1) Fix reviewer execution path in harness_execute.
- Current bug: harness_execute spawns reviewer via SessionManager/Claude session even when reviewModel is openai-codex/gpt-5.4.
- Expected: reviewer should run through the correct GPT/Codex-capable path.
- Keep worker path as-is.

2) Improve planner decomposition quality.
- Current bug: tier-2 plans decompose one request into many useless literal fragments like src/tools/harness-execute.ts or return bullets as separate tasks.
- Make planner output materially better.

3) Validate both fixes as practically as possible.
- Build.
- Add targeted tests if appropriate.
- Commit cleanly.

Return:
- root cause
- files changed
- commit hash
- what still remains unfixed`;

    const plan = planner.buildPlan(request, 2);

    assert.equal(plan.tasks.length, 3, "top-level numbered items should become the only tasks");
    assert.ok(plan.tasks[0].title.includes("Fix reviewer execution path"));
    assert.ok(plan.tasks[1].title.includes("Improve planner decomposition quality"));
    assert.ok(plan.tasks[2].title.includes("Validate both fixes"));
    assert.ok(plan.tasks.every((task) => !/root cause|files changed|commit hash|still remains/i.test(task.title)));
  } finally {
    cleanup();
  }
}

function testPlannerGroupsStandaloneFileBullets() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const request = `Tasks:
- Fix reviewer execution path for GPT reviewer backend
- src/tools/harness-execute.ts
- src/reviewer-runner.ts
- Improve planner decomposition quality
- src/planner.ts

Return:
- commit hash`;

    const plan = planner.buildPlan(request, 2);

    assert.equal(plan.tasks.length, 2, "standalone file bullets should not become their own tasks");
    assert.match(plan.tasks[0].scope, /Relevant files: .*src\/tools\/harness-execute\.ts.*src\/reviewer-runner\.ts/);
    assert.match(plan.tasks[1].scope, /Relevant files: .*src\/planner\.ts/);
  } finally {
    cleanup();
  }
}

async function testModelPlannerFallsBackToSonnet() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const plan = await planner.buildModelPlan(
      "Implement internal planner fallback coverage",
      "",
      "/tmp/project",
      async ({ requestedModel }) => {
        if (requestedModel === "opus") {
          throw new Error("primary planner unavailable");
        }

        return {
          launchModel: requestedModel,
          output: '```json\n{"tasks":[{"id":"task-1","title":"Implement internal planner fallback coverage","scope":"src/planner.ts","acceptance_criteria":["planner metadata records fallback"],"agent":"codex"}],"mode":"solo","estimated_complexity":"medium"}\n```',
        };
      },
    );

    assert.equal(plan.plannerMetadata.backend, "model");
    assert.equal(plan.plannerMetadata.model, "sonnet");
    assert.equal(plan.plannerMetadata.fallback, true);
    assert.match(plan.plannerMetadata.fallbackReason, /opus: primary planner unavailable/);
    assert.equal(plan.tasks.length, 1);
  } finally {
    cleanup();
  }
}

async function testModelPlannerFallsBackToHeuristic() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const plan = await planner.buildModelPlan(
      `1) Fix planner integration\n2) Add fallback metadata`,
      "",
      "/tmp/project",
      async ({ requestedModel }) => {
        throw new Error(`planner failed for ${requestedModel}`);
      },
    );

    assert.equal(plan.plannerMetadata.backend, "heuristic");
    assert.equal(plan.plannerMetadata.fallback, true);
    assert.match(plan.plannerMetadata.fallbackReason, /opus: planner failed for opus/);
    assert.match(plan.plannerMetadata.fallbackReason, /sonnet: planner failed for sonnet/);
    assert.ok(plan.tasks.length >= 1);
  } finally {
    cleanup();
  }
}

async function testModelPlannerMergesImplementationAndTests() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const plan = await planner.buildModelPlan(
      "Implement a Kalshi Kelly optimizer and add tests.",
      "",
      "/tmp/project",
      async () => ({
        launchModel: "opus",
        output: '```json\n{"tasks":[{"id":"task-1","title":"Implement Kalshi Kelly optimizer","scope":"scripts/optuna/kalshi_kelly_optimizer.py","acceptance_criteria":["optimizer script exists"],"agent":"codex"},{"id":"task-2","title":"Add tests for Kalshi Kelly optimizer","scope":"tests/test_kalshi_kelly_optimizer.py","acceptance_criteria":["pytest tests/test_kalshi_kelly_optimizer.py passes"],"agent":"codex"},{"id":"task-3","title":"Verify build and summarize","scope":"Run tests and report files changed","acceptance_criteria":["tests pass","files changed summarized"],"agent":"codex"}],"mode":"sequential","estimated_complexity":"medium"}\n```',
      }),
    );

    assert.equal(plan.tasks.length, 1, "implementation, tests, and verification should remain one coherent task");
    assert.match(plan.tasks[0].scope, /kalshi_kelly_optimizer\.py/);
    assert.match(plan.tasks[0].scope, /test_kalshi_kelly_optimizer\.py/);
    assert.ok(plan.tasks[0].acceptanceCriteria.some((c) => /pytest tests\/test_kalshi_kelly_optimizer\.py passes/.test(c)));
  } finally {
    cleanup();
  }
}

function testWorkspaceIsolationHandlesUnbornHeadRepos() {
  const tempRepo = mkdtempSync(join(tmpdir(), "openclaw-harness-unborn-head-"));
  const { mod: isolation, cleanup } = loadTsModule("src/workspace-isolation.ts");

  try {
    execFileSync("git", ["init", "-q"], { cwd: tempRepo });
    writeFileSync(join(tempRepo, "README.md"), "initial\n", "utf8");
    writeFileSync(join(tempRepo, "CLAUDE.md"), "# context\n", "utf8");

    const prepared = isolation.prepareExecutionWorkspace(tempRepo, "plan-unborn-head");
    assert.equal(prepared.isolated, true);
    assert.notEqual(prepared.executionWorkdir, tempRepo);
    assert.equal(readFileSync(join(prepared.executionWorkdir, "README.md"), "utf8"), "initial\n");
    assert.ok(existsSync(join(prepared.executionWorkdir, ".git")), "clone should remain a git repo");

    writeFileSync(join(prepared.executionWorkdir, "README.md"), "updated\n", "utf8");
    writeFileSync(join(prepared.executionWorkdir, "NEW.md"), "new file\n", "utf8");

    const materialized = isolation.materializeExecutionWorkspace(prepared);
    assert.equal(materialized.applied, true);
    assert.equal(readFileSync(join(tempRepo, "README.md"), "utf8"), "updated\n");
    assert.equal(readFileSync(join(tempRepo, "NEW.md"), "utf8"), "new file\n");
  } finally {
    cleanup();
    rmSync(tempRepo, { recursive: true, force: true });
  }
}

function testReviewerBackendSelection() {
  const { mod: reviewerRunner, cleanup } = loadTsModule("src/reviewer-runner.ts");

  try {
    const codexTarget = reviewerRunner.resolveReviewerExecutionTarget("openai-codex/gpt-5.4", "sonnet");
    assert.equal(codexTarget.backend, "codex-cli");
    assert.equal(codexTarget.launchModel, "gpt-5.4");

    const claudeTarget = reviewerRunner.resolveReviewerExecutionTarget("anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.4");
    assert.equal(claudeTarget.backend, "claude-session");
    assert.equal(claudeTarget.launchModel, "sonnet");
  } finally {
    cleanup();
  }
}

function testClaudeModelResolutionNormalizesCanonicalRefs() {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-harness-model-test-"));
  const configPath = join(tempDir, "openclaw.json");
  const priorConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  require("node:fs").writeFileSync(configPath, JSON.stringify({
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-6": { alias: "opus46" },
          "anthropic/claude-sonnet-4-6": { alias: "sonnet46" }
        }
      }
    }
  }), "utf8");
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const { mod: modelResolution, cleanup } = loadTsModule("src/model-resolution.ts");

  try {
    assert.equal(modelResolution.resolveModelAlias("anthropic/claude-opus-4-6"), "opus");
    assert.equal(modelResolution.resolveModelAlias("anthropic/claude-sonnet-4-6"), "sonnet");
    assert.equal(modelResolution.resolveModelAlias("opus46"), "opus");
    assert.equal(modelResolution.resolveModelAlias("sonnet46"), "sonnet");
  } finally {
    cleanup();
    if (priorConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = priorConfigPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testReviewerCommandUsesCodexReadOnlyPath() {
  const { mod: reviewerRunner, cleanup } = loadTsModule("src/reviewer-runner.ts");

  try {
    const command = reviewerRunner.buildCodexReviewerCommand({
      workdir: "/tmp/project",
      outputFile: "/tmp/project/review.json",
      model: "gpt-5.4",
      prompt: "review this",
    });

    assert.equal(command.command, "codex");
    assert.deepEqual(command.args.slice(0, 2), ["exec", "-"]);
    assert.ok(command.args.includes("--sandbox"));
    assert.ok(command.args.includes("read-only"));
    assert.ok(command.args.includes("--output-last-message"));
    assert.ok(command.args.includes("-m"));
    assert.ok(command.prompt.includes("You are a code reviewer."));
    assert.ok(command.prompt.includes("review this"));
  } finally {
    cleanup();
  }
}

function testReviewerCommandSetsCodexReasoningEffort() {
  const { mod: reviewerRunner, cleanup } = loadTsModule("src/reviewer-runner.ts");

  try {
    const command = reviewerRunner.buildCodexReviewerCommand({
      workdir: "/tmp/project",
      outputFile: "/tmp/project/review.json",
      model: "gpt-5.4",
      prompt: "review this",
      reasoningEffort: "xhigh",
    });

    const reasoningIndex = command.args.indexOf("-c");
    assert.ok(reasoningIndex >= 0, "expected codex reasoning config override");
    assert.equal(command.args[reasoningIndex + 1], 'model_reasoning_effort="xhigh"');
  } finally {
    cleanup();
  }
}

// --- Planner JSON parser tests ---

function testPlannerJsonParsesFencedJson() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const output = `Here is the plan:

\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Fix authentication",
      "scope": "src/auth.ts",
      "acceptance_criteria": ["Auth works correctly", "Tests pass"],
      "agent": "codex"
    },
    {
      "id": "task-2",
      "title": "Update API routes",
      "scope": "src/routes.ts",
      "acceptance_criteria": ["Routes updated"],
      "agent": "claude"
    }
  ],
  "mode": "parallel",
  "estimated_complexity": "medium"
}
\`\`\`

That should cover all the changes needed.`;

    const parsed = planner.parsePlannerJson(output);
    assert.ok(parsed, "parsePlannerJson should return a result");
    assert.equal(parsed.tasks.length, 2);
    assert.equal(parsed.tasks[0].id, "task-1");
    assert.equal(parsed.tasks[0].title, "Fix authentication");
    assert.equal(parsed.tasks[0].scope, "src/auth.ts");
    assert.deepEqual(parsed.tasks[0].acceptance_criteria, ["Auth works correctly", "Tests pass"]);
    assert.equal(parsed.tasks[0].agent, "codex");
    assert.equal(parsed.tasks[1].agent, "claude");
    assert.equal(parsed.mode, "parallel");
    assert.equal(parsed.estimated_complexity, "medium");
  } finally {
    cleanup();
  }
}

function testPlannerJsonRejectsInvalidJson() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    // No JSON block at all
    assert.equal(planner.parsePlannerJson("Here is some prose with no JSON"), null);

    // Empty tasks array
    assert.equal(planner.parsePlannerJson('```json\n{"tasks": [], "mode": "solo"}\n```'), null);

    // Missing title (required field)
    assert.equal(planner.parsePlannerJson('```json\n{"tasks": [{"id": "task-1", "scope": "x"}], "mode": "solo"}\n```'), null);

    // Not an object
    assert.equal(planner.parsePlannerJson('```json\n"just a string"\n```'), null);
  } finally {
    cleanup();
  }
}

function testPlannerJsonDefaultsAndNormalization() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    // Missing optional fields: scope defaults to title, agent to codex, criteria to [title]
    const output = '```json\n{"tasks": [{"id": "task-1", "title": "Do something"}], "mode": "invalid_mode", "estimated_complexity": "invalid"}\n```';
    const parsed = planner.parsePlannerJson(output);
    assert.ok(parsed);
    assert.equal(parsed.tasks[0].scope, "Do something"); // defaults to title
    assert.equal(parsed.tasks[0].agent, "codex"); // default agent
    assert.deepEqual(parsed.tasks[0].acceptance_criteria, ["Do something"]); // defaults to [title]
    assert.equal(parsed.mode, "sequential"); // invalid mode → default sequential
    assert.equal(parsed.estimated_complexity, "high"); // invalid complexity → default high
  } finally {
    cleanup();
  }
}

function testPlannerJsonIgnoresProseOutsideFence() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const output = `I analyzed the request and here are the tasks:

Some additional context about why I chose these tasks.

\`\`\`json
{
  "tasks": [{"id": "task-1", "title": "Single task", "scope": "src/main.ts", "acceptance_criteria": ["Works"], "agent": "codex"}],
  "mode": "solo",
  "estimated_complexity": "low"
}
\`\`\`

Let me know if you want changes.`;

    const parsed = planner.parsePlannerJson(output);
    assert.ok(parsed);
    assert.equal(parsed.tasks.length, 1);
    assert.equal(parsed.tasks[0].title, "Single task");
    assert.equal(parsed.mode, "solo");
    assert.equal(parsed.estimated_complexity, "low");
  } finally {
    cleanup();
  }
}

function testExtractFencedJsonHandlesGenericFence() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    // Generic ``` block with JSON content (no "json" language tag)
    const output = "Here:\n```\n{\"tasks\": [{\"id\": \"task-1\", \"title\": \"Test\", \"scope\": \"x\", \"acceptance_criteria\": [\"y\"], \"agent\": \"codex\"}], \"mode\": \"solo\", \"estimated_complexity\": \"low\"}\n```";
    const json = planner.extractFencedJson(output);
    assert.ok(json);
    assert.ok(json.startsWith("{"));

    // Generic ``` block with non-JSON content should be skipped
    const nonJson = "Here:\n```\nThis is not JSON\n```";
    const result = planner.extractFencedJson(nonJson);
    assert.equal(result, null);
  } finally {
    cleanup();
  }
}

async function testModelPlannerUsesJsonPrimary() {
  const { mod: planner, cleanup } = loadTsModule("src/planner.ts");

  try {
    const plan = await planner.buildModelPlan(
      "Implement feature X",
      "",
      "/tmp/project",
      async ({ requestedModel }) => {
        if (requestedModel !== "opus") throw new Error("not opus");
        return {
          launchModel: "opus",
          output: '```json\n{"tasks": [{"id": "task-1", "title": "Implement feature X", "scope": "src/feature.ts", "acceptance_criteria": ["Feature works"], "agent": "codex"}], "mode": "solo", "estimated_complexity": "medium"}\n```',
        };
      },
    );

    assert.equal(plan.plannerMetadata.backend, "model");
    assert.equal(plan.plannerMetadata.model, "opus");
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].title, "Implement feature X");
  } finally {
    cleanup();
  }
}

function testExtractFilePathsCapturesRootAndNestedFiles() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");

  try {
    const output = [
      "Files changed:",
      "- calc.py",
      "- cli.py",
      "- README.md",
      "- src/tools/harness-execute.ts",
      "- ./test_calc.py",
      "See also `package.json` and `.env.example`",
      "Manual verify with `python3 cli.py` and `python cli.py`",
      "Absolute path reference: `/tmp/project/test_calc.py`",
    ].join("\n");

    const files = harnessExecute.extractRelevantFilePaths(output, '/tmp/project');
    assert.deepEqual(files, [
      "calc.py",
      "cli.py",
      "README.md",
      "src/tools/harness-execute.ts",
      "test_calc.py",
      "package.json",
      ".env.example",
    ]);
  } finally {
    cleanup();
  }
}

function testHarnessDefersTransientPlanViolationDuringRoundComplete() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-harness-realtime-plan-"));

  try {
    writeFileSync(join(stateDir, "result-1.json"), JSON.stringify({
      subtype: "success",
      is_error: false,
      result: "Plan summary:\n\nNeed to update the optimizer.",
      permission_denials: [{ tool_name: "ExitPlanMode" }],
      session_id: "sess-1",
      num_turns: 3,
      total_cost_usd: 0.12,
    }), "utf8");

    const latest = harnessExecute.__readLatestRealtimeResultForTests(stateDir);
    assert.deepEqual(latest.permissionDenials, ["ExitPlanMode"]);
    assert.equal(latest.round, 1);
    assert.equal(
      harnessExecute.__classifyPlanViolationHandlingForTests(stateDir, "round-complete"),
      "defer",
    );
    assert.equal(
      harnessExecute.__classifyPlanViolationHandlingForTests(stateDir, "terminal"),
      "terminal",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    cleanup();
  }
}

function testHarnessRequiresProjectContextBeforeRealtimeLaunch() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-claude-md-missing-"));

  try {
    assert.equal(harnessExecute.__hasRealtimeProjectContextForTests(workdir), false);
    writeFileSync(join(workdir, "CLAUDE.md"), "# context\n", "utf8");
    assert.equal(harnessExecute.__hasRealtimeProjectContextForTests(workdir), true);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

function testHarnessPromotesLaterSuccessAfterPlanViolation() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-harness-realtime-success-"));

  try {
    writeFileSync(join(stateDir, "result-1.json"), JSON.stringify({
      subtype: "success",
      is_error: false,
      result: "Plan summary:\n\nNeed to update the optimizer.",
      permission_denials: [{ tool_name: "ExitPlanMode" }],
      session_id: "sess-1",
      num_turns: 3,
      total_cost_usd: 0.12,
    }), "utf8");
    writeFileSync(join(stateDir, "result-2.json"), JSON.stringify({
      subtype: "success",
      is_error: false,
      result: "## Summary\n\nCommit: abc123\n\nTests Passed: 151 passed in 0.53s",
      permission_denials: [],
      session_id: "sess-1",
      num_turns: 83,
      total_cost_usd: 6.24,
    }), "utf8");

    const latest = harnessExecute.__readLatestRealtimeResultForTests(stateDir);
    assert.equal(latest.round, 2);
    assert.deepEqual(latest.permissionDenials, []);
    assert.equal(
      harnessExecute.__classifyPlanViolationHandlingForTests(stateDir, "round-complete"),
      "waiting",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    cleanup();
  }
}

function testHarnessReadsSuccessFromStreamWhenResultFileIsMissing() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-harness-realtime-stream-success-"));

  try {
    writeFileSync(join(stateDir, "stream-1.jsonl"), [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Let me explore the codebase first." }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "## Plan\n\nTrivial change. Update function and test, then run npm test.",
        permission_denials: [],
        session_id: "sess-stream-1",
        num_turns: 4,
        total_cost_usd: 0.2,
      }),
      '{"type":"result","subtype":"success"',
      "",
    ].join("\n"), "utf8");

    const latest = harnessExecute.__readLatestRealtimeResultForTests(stateDir);
    assert.equal(latest.round, 1);
    assert.equal(latest.sessionId, "sess-stream-1");
    assert.equal(latest.subtype, "success");
    assert.equal(latest.isError, false);
    assert.equal(latest.resultText.includes("Trivial change"), true);
    assert.equal(
      harnessExecute.__classifyPlanViolationHandlingForTests(stateDir, "round-complete"),
      "waiting",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    cleanup();
  }
}

function testRealtimeCheckpointReviewModes() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");

  try {
    assert.equal(
      harnessExecute.__realtimeCheckpointReviewModeForTests("plan_waiting", "round-complete"),
      "embedded-plan",
    );
    assert.equal(
      harnessExecute.__realtimeCheckpointReviewModeForTests("waiting", "round-complete"),
      null,
    );
    assert.equal(
      harnessExecute.__realtimeCheckpointReviewModeForTests("waiting", "terminal"),
      null,
    );
  } finally {
    cleanup();
  }
}

function testCheckpointMarksFailedWhenTaskFailsEarly() {
  const { mod: checkpointMod, cleanup } = loadTsModule("src/checkpoint.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-checkpoint-"));

  try {
    const plan = {
      id: "plan-test-fail-early",
      originalRequest: "test",
      tasks: [
        { id: "task-1", title: "one", scope: "calc.py", acceptanceCriteria: ["a"], agent: "codex" },
        { id: "task-2", title: "two", scope: "cli.py", acceptanceCriteria: ["b"], agent: "codex" },
      ],
      mode: "sequential",
      estimatedComplexity: "medium",
      tier: 2,
    };

    const checkpoint = checkpointMod.initCheckpoint(plan, workdir);
    checkpointMod.updateTaskStatus(checkpoint, "task-1", "failed", workdir, {
      reviewPassed: false,
    });

    assert.equal(checkpoint.status, "failed");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

function testFindRecoverableCheckpointMatchesSymlinkedWorkdir() {
  const { mod: checkpointMod, cleanup } = loadTsModule("src/checkpoint.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-recover-real-"));
  const aliasParent = mkdtempSync(join(tmpdir(), "openclaw-harness-recover-link-"));
  const aliasPath = join(aliasParent, "alias-workdir");

  try {
    symlinkSync(workdir, aliasPath, "dir");

    const plan = {
      id: "plan-test-recover-symlink",
      originalRequest: "resume using symlink path",
      tasks: [
        { id: "task-1", title: "one", scope: "calc.py", acceptanceCriteria: ["a"], agent: "codex" },
      ],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    };

    const checkpoint = checkpointMod.initCheckpoint(plan, workdir, join(workdir, ".isolated-clone"));
    checkpointMod.recordSession(checkpoint, "task-1", "worker", "job-symlink", workdir);
    checkpointMod.updateTaskStatus(checkpoint, "task-1", "in-review", workdir, { reviewPassed: false });

    const recovered = checkpointMod.findRecoverableCheckpoint("resume using symlink path", aliasPath);
    assert.ok(recovered, "expected checkpoint match through symlink alias");
    assert.equal(recovered.runId, "plan-test-recover-symlink");
  } finally {
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

function testFindRecoverableCheckpointMatchesRequestAndWorkdir() {
  const { mod: checkpointMod, cleanup } = loadTsModule("src/checkpoint.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-recover-"));
  const otherWorkdir = mkdtempSync(join(tmpdir(), "openclaw-harness-recover-other-"));
  const isolatedExecDir = mkdtempSync(join(tmpdir(), "openclaw-harness-recover-exec-"));

  try {
    const matchingPlan = {
      id: "plan-test-recover-match",
      originalRequest: "resume this exact request",
      tasks: [
        { id: "task-1", title: "one", scope: "calc.py", acceptanceCriteria: ["a"], agent: "codex" },
      ],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    };

    const pendingOnlyPlan = {
      id: "plan-test-recover-pending",
      originalRequest: "resume this exact request",
      tasks: [
        { id: "task-1", title: "one", scope: "calc.py", acceptanceCriteria: ["a"], agent: "codex" },
      ],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    };

    const otherWorkdirPlan = {
      id: "plan-test-recover-other",
      originalRequest: "resume this exact request",
      tasks: [
        { id: "task-1", title: "one", scope: "calc.py", acceptanceCriteria: ["a"], agent: "codex" },
      ],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    };

    const matching = checkpointMod.initCheckpoint(matchingPlan, workdir, isolatedExecDir);
    checkpointMod.recordSession(matching, "task-1", "worker", "job-1", workdir);
    checkpointMod.updateTaskStatus(matching, "task-1", "in-review", workdir, { reviewPassed: false });

    checkpointMod.initCheckpoint(pendingOnlyPlan, workdir, workdir);

    const other = checkpointMod.initCheckpoint(otherWorkdirPlan, otherWorkdir);
    checkpointMod.recordSession(other, "task-1", "worker", "job-2", otherWorkdir);
    checkpointMod.updateTaskStatus(other, "task-1", "in-review", otherWorkdir, { reviewPassed: false });

    const recovered = checkpointMod.findRecoverableCheckpoint("resume this exact request", workdir);
    assert.ok(recovered, "expected a recoverable checkpoint");
    assert.equal(recovered.runId, "plan-test-recover-match");
    const normalize = (value) => {
      const resolved = require("node:path").resolve(value);
      try {
        return typeof require("node:fs").realpathSync.native === "function"
          ? require("node:fs").realpathSync.native(resolved)
          : require("node:fs").realpathSync(resolved);
      } catch {
        return resolved;
      }
    };
    assert.equal(recovered.workdir, normalize(workdir));
    assert.equal(recovered.executionWorkdir, normalize(isolatedExecDir));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(otherWorkdir, { recursive: true, force: true });
    rmSync(isolatedExecDir, { recursive: true, force: true });
    cleanup();
  }
}

async function testLocalCcBackendReusesCompletedExecuteOutput() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-work-"));
  const jobId = `test-local-cc-execute-${Date.now()}`;
  let calls = 0;

  const context = {
    task: {
      id: "task-1",
      title: "Implement local backend",
      scope: "src/backend/local-cc.ts",
      acceptanceCriteria: ["local-cc executes locally"],
      agent: "claude",
    },
    plan: {
      id: "plan-local-cc",
      originalRequest: "Implement the local backend",
      tasks: [],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    },
    workdir,
    ctx: {},
    workerModel: "anthropic/claude-sonnet-4-6",
    jobId,
  };

  localCc.__setLocalCcCommandExecutorForTests(async () => {
    calls++;
    return {
      exitCode: 0,
      stdout: [
        "Summary:",
        "Implemented the local backend.",
        "",
        "Files changed:",
        "- src/backend/local-cc.ts",
        "- src/tools/harness-execute.ts",
        "",
        "Tests run:",
        "3 tests passed",
        "",
        "Warnings:",
        "- warning: review remaining edge cases",
      ].join("\n"),
      stderr: "",
    };
  });

  try {
    const first = await localCc.localCcBackend.executeWorker(context);
    const second = await localCc.localCcBackend.executeWorker(context);
    const state = localCc.readLocalCcJobState(jobId);

    assert.equal(calls, 1, "same jobId should reuse completed execute output");
    assert.equal(first.status, "waiting");
    assert.equal(second.status, "waiting");
    assert.deepEqual(first.workerResult.filesChanged, [
      "src/backend/local-cc.ts",
      "src/tools/harness-execute.ts",
    ]);
    assert.equal(first.workerResult.testsRun, 3);
    assert.deepEqual(first.workerResult.warnings, [
      "- warning: review remaining edge cases",
    ]);
    assert.equal(first.stateDir, localCc.getLocalCcStateDir(jobId));
    assert.ok(!first.stateDir.startsWith(resolve(workdir) + "/"), "state dir must live outside the user repo");
    assert.ok(state, "expected persisted local-cc state");
    assert.equal(state.status, "waiting");
    assert.equal(state.rounds.length, 1);
    assert.equal(state.rounds[0].kind, "execute");
    assert.equal(state.rounds[0].status, "completed");
  } finally {
    localCc.__resetLocalCcCommandExecutorForTests();
    rmSync(localCc.getLocalCcStateDir(jobId), { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

async function testLocalCcBackendReusesContinueOutputAndFinalizes() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-followup-"));
  const jobId = `test-local-cc-continue-${Date.now()}`;
  let calls = 0;

  const context = {
    task: {
      id: "task-2",
      title: "Address review feedback",
      scope: "src/backend/local-cc.ts",
      acceptanceCriteria: ["review feedback is applied"],
      agent: "claude",
    },
    plan: {
      id: "plan-local-cc-followup",
      originalRequest: "Implement local backend and fix review gaps",
      tasks: [],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    },
    workdir,
    ctx: {},
    workerModel: "sonnet",
    jobId,
  };

  localCc.__setLocalCcCommandExecutorForTests(async () => {
    calls++;
    if (calls === 1) {
      return {
        exitCode: 0,
        stdout: [
          "Summary:",
          "Initial implementation complete.",
          "",
          "Files changed:",
          "- src/backend/local-cc.ts",
          "",
          "Tests run:",
          "1 test passed",
          "",
          "Warnings:",
          "- warning: add state reuse coverage",
        ].join("\n"),
        stderr: "",
      };
    }

    return {
      exitCode: 0,
      stdout: [
        "Summary:",
        "Addressed reviewer feedback and added state reuse coverage.",
        "",
        "Files changed:",
        "- src/backend/local-cc.ts",
        "- scripts/run-tests.js",
        "",
        "Tests run:",
        "2 tests passed",
        "",
        "Warnings:",
      ].join("\n"),
      stderr: "",
    };
  });

  try {
    await localCc.localCcBackend.executeWorker(context);
    const feedback = "Add focused coverage for jobId state reuse.";
    const firstContinue = await localCc.localCcBackend.continueWorker(context, feedback);
    const secondContinue = await localCc.localCcBackend.continueWorker(context, feedback);
    const reusedExecute = await localCc.localCcBackend.executeWorker(context);
    const final = await localCc.localCcBackend.finalizeWorker(context);
    const state = localCc.readLocalCcJobState(jobId);

    assert.equal(calls, 2, "continueWorker should reuse the completed follow-up round for the same feedback");
    assert.equal(firstContinue.status, "waiting");
    assert.equal(secondContinue.status, "waiting");
    assert.equal(reusedExecute.status, "waiting");
    assert.deepEqual(firstContinue.workerResult.filesChanged, [
      "src/backend/local-cc.ts",
      "scripts/run-tests.js",
    ]);
    assert.deepEqual(reusedExecute.workerResult.filesChanged, [
      "src/backend/local-cc.ts",
      "scripts/run-tests.js",
    ]);
    assert.equal(final.status, "done");
    assert.equal(final.workerResult.testsRun, 2);
    assert.ok(state, "expected persisted local-cc state");
    assert.equal(state.status, "done");
    assert.equal(state.rounds.length, 2);
    assert.equal(state.rounds[1].kind, "continue");
    assert.equal(state.rounds[1].status, "completed");
    assert.ok(state.rounds[1].feedbackHash, "expected persisted feedback hash for continue reuse");
  } finally {
    localCc.__resetLocalCcCommandExecutorForTests();
    rmSync(localCc.getLocalCcStateDir(jobId), { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

function testSessionPrefersClaudeCredentialsOverGatewayApiKey() {
  const { mod: sessionMod, cleanup } = loadTsModule("src/session.ts");
  const tempHome = mkdtempSync(join(tmpdir(), "openclaw-harness-session-home-"));

  try {
    const claudeDir = join(tempHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), '{"token":"present"}\n', "utf8");

    assert.equal(
      sessionMod.__shouldPreferClaudeCredentialsForTests({
        HOME: tempHome,
        ANTHROPIC_API_KEY: "invalid-key",
      }),
      true,
    );

    assert.equal(
      sessionMod.__shouldPreferClaudeCredentialsForTests({
        HOME: tempHome,
      }),
      false,
    );
  } finally {
    cleanup();
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function testLocalCcArgsIncludeClaudeEffort() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");

  try {
    const args = localCc.__buildLocalCcArgsForTests("claude-opus-4-6", "Solve it.", "high");
    const effortIndex = args.indexOf("--effort");
    assert.ok(effortIndex >= 0, "expected Claude effort flag");
    assert.equal(args[effortIndex + 1], "high");
  } finally {
    cleanup();
  }
}

function testLocalCcChildEnvPrefersClaudeCredentialsOverGatewayApiKey() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const tempHome = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-home-"));

  try {
    const claudeDir = join(tempHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), '{"token":"present"}\n', "utf8");

    const env = localCc.__buildLocalCcChildEnvForTests({
      HOME: tempHome,
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "invalid-key",
      OTHER_VAR: "keep-me",
    });

    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OTHER_VAR, "keep-me");
    assert.equal(env.HOME, tempHome);
  } finally {
    cleanup();
    rmSync(tempHome, { recursive: true, force: true });
  }
}

async function testLocalCcBackendReportsMissingCliClearly() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-missing-cli-"));
  const jobId = `test-local-cc-missing-cli-${Date.now()}`;

  const context = {
    task: {
      id: "task-3",
      title: "Fail clearly when claude CLI is missing",
      scope: "src/backend/local-cc.ts",
      acceptanceCriteria: ["errors are clear"],
      agent: "claude",
    },
    plan: {
      id: "plan-local-cc-missing-cli",
      originalRequest: "Surface a clear local-cc CLI error",
      tasks: [],
      mode: "solo",
      estimatedComplexity: "low",
      tier: 1,
    },
    workdir,
    ctx: {},
    workerModel: "claude",
    jobId,
  };

  localCc.__setLocalCcCommandExecutorForTests(async () => ({
    exitCode: -1,
    stdout: "",
    stderr: "",
    error: 'Claude Code CLI not found on PATH. Install the local `claude` CLI or switch workerBackend to "remote-realtime".',
  }));

  try {
    const result = await localCc.localCcBackend.executeWorker(context);
    const state = localCc.readLocalCcJobState(jobId);

    assert.equal(result.status, "error");
    assert.equal(result.workerResult, null);
    assert.match(result.error, /Claude Code CLI not found on PATH/);
    assert.ok(state, "expected persisted local-cc state");
    assert.equal(state.status, "error");
    assert.equal(state.rounds.length, 1);
    assert.equal(state.rounds[0].status, "failed");
    assert.match(state.lastError, /switch workerBackend to "remote-realtime"/);
  } finally {
    localCc.__resetLocalCcCommandExecutorForTests();
    rmSync(localCc.getLocalCcStateDir(jobId), { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

async function testLocalCcWorkdirMismatchRecovery() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const oldWorkdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-old-"));
  const newWorkdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-new-"));
  const jobId = `test-local-cc-workdir-migration-${Date.now()}`;
  let calls = 0;

  const makeContext = (workdir) => ({
    task: {
      id: "task-wd-1",
      title: "Test workdir migration",
      scope: "src/backend/local-cc.ts",
      acceptanceCriteria: ["workdir migration works"],
      agent: "claude",
    },
    plan: {
      id: "plan-wd-1",
      originalRequest: "Test workdir migration",
      tasks: [],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    },
    workdir,
    ctx: {},
    workerModel: "anthropic/claude-sonnet-4-6",
    jobId,
  });

  localCc.__setLocalCcCommandExecutorForTests(async () => {
    calls++;
    return {
      exitCode: 0,
      stdout: "Summary:\nDone.\n\nFiles changed:\n- file.ts\n\nTests run:\n1 tests passed\n\nWarnings:",
      stderr: "",
    };
  });

  try {
    // First execute with old workdir creates state
    const first = await localCc.localCcBackend.executeWorker(makeContext(oldWorkdir));
    assert.equal(first.status, "waiting");
    assert.equal(calls, 1);

    const stateAfterFirst = localCc.readLocalCcJobState(jobId);
    assert.equal(stateAfterFirst.workdir, resolve(oldWorkdir));

    // Second execute with new workdir should recover gracefully, not throw
    const second = await localCc.localCcBackend.executeWorker(makeContext(newWorkdir));
    assert.equal(second.status, "waiting", "should reuse completed round after workdir migration");

    const stateAfterMigration = localCc.readLocalCcJobState(jobId);
    assert.equal(stateAfterMigration.workdir, resolve(newWorkdir), "state.workdir should be updated to new workdir");
    assert.equal(stateAfterMigration.taskId, "task-wd-1");
    assert.equal(stateAfterMigration.planId, "plan-wd-1");

    // CLI should NOT have been called again — reused existing round
    assert.equal(calls, 1, "should reuse completed output, not re-execute");
  } finally {
    localCc.__resetLocalCcCommandExecutorForTests();
    rmSync(localCc.getLocalCcStateDir(jobId), { recursive: true, force: true });
    rmSync(oldWorkdir, { recursive: true, force: true });
    rmSync(newWorkdir, { recursive: true, force: true });
    cleanup();
  }
}

async function testLocalCcWorkdirMismatchRecoveryVanishedOldDir() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const oldWorkdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-vanish-"));
  const newWorkdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-new2-"));
  const jobId = `test-local-cc-vanished-workdir-${Date.now()}`;

  const makeContext = (workdir) => ({
    task: {
      id: "task-vanish-1",
      title: "Test vanished workdir",
      scope: "src/backend/local-cc.ts",
      acceptanceCriteria: ["vanished workdir recovers"],
      agent: "claude",
    },
    plan: {
      id: "plan-vanish-1",
      originalRequest: "Test vanished workdir",
      tasks: [],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    },
    workdir,
    ctx: {},
    workerModel: "anthropic/claude-sonnet-4-6",
    jobId,
  });

  localCc.__setLocalCcCommandExecutorForTests(async () => ({
    exitCode: 0,
    stdout: "Summary:\nDone.\n\nFiles changed:\n- file.ts\n\nTests run:\n0\n\nWarnings:",
    stderr: "",
  }));

  try {
    await localCc.localCcBackend.executeWorker(makeContext(oldWorkdir));

    // Remove old workdir to simulate it vanishing
    rmSync(oldWorkdir, { recursive: true, force: true });
    assert.ok(!existsSync(oldWorkdir), "old workdir should be gone");

    // Execute with new workdir — should recover, not throw
    const result = await localCc.localCcBackend.executeWorker(makeContext(newWorkdir));
    assert.equal(result.status, "waiting");

    const state = localCc.readLocalCcJobState(jobId);
    assert.equal(state.workdir, resolve(newWorkdir));
  } finally {
    localCc.__resetLocalCcCommandExecutorForTests();
    rmSync(localCc.getLocalCcStateDir(jobId), { recursive: true, force: true });
    rmSync(newWorkdir, { recursive: true, force: true });
    cleanup();
  }
}

async function testLocalCcTaskMismatchStillThrows() {
  const { mod: localCc, cleanup } = loadTsModule("src/backend/local-cc.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-localcc-mismatch-"));
  const jobId = `test-local-cc-task-mismatch-${Date.now()}`;

  const makeContext = (taskId) => ({
    task: {
      id: taskId,
      title: "Test task mismatch",
      scope: "src/backend/local-cc.ts",
      acceptanceCriteria: ["mismatch throws"],
      agent: "claude",
    },
    plan: {
      id: "plan-mismatch-1",
      originalRequest: "Test mismatch",
      tasks: [],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 2,
    },
    workdir,
    ctx: {},
    workerModel: "anthropic/claude-sonnet-4-6",
    jobId,
  });

  localCc.__setLocalCcCommandExecutorForTests(async () => ({
    exitCode: 0,
    stdout: "Summary:\nDone.\n\nFiles changed:\n\nTests run:\n\nWarnings:",
    stderr: "",
  }));

  try {
    await localCc.localCcBackend.executeWorker(makeContext("task-a"));

    // Same jobId, different taskId — should error (caught by error boundary)
    const result = await localCc.localCcBackend.executeWorker(makeContext("task-b"));
    assert.equal(result.status, "error");
    assert.ok(result.error.includes("task mismatch"), "should report task mismatch: " + result.error);
  } finally {
    localCc.__resetLocalCcCommandExecutorForTests();
    rmSync(localCc.getLocalCcStateDir(jobId), { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

// --- Review-only lane tests ---

async function withCleanGitEnv(fn) {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  try {
    return await fn();
  } finally {
    if (saved.GIT_DIR !== undefined) process.env.GIT_DIR = saved.GIT_DIR;
    if (saved.GIT_WORK_TREE !== undefined) process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE;
  }
}

async function testCollectLocalChangesFindsModifiedFiles() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-review-only-"));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GIT_DIR" && k !== "GIT_WORK_TREE"));
  const git = (...args) => execFileSync("git", args, { cwd: workdir, env: cleanEnv });

  try {
    git("init");
    writeFileSync(join(workdir, "file1.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(workdir, "file2.ts"), "export const b = 2;\n", "utf8");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "init");
    writeFileSync(join(workdir, "file1.ts"), "export const a = 42;\n", "utf8");
    writeFileSync(join(workdir, "newfile.ts"), "export const c = 3;\n", "utf8");

    const result = await withCleanGitEnv(() => harnessExecute.collectLocalChanges(workdir));
    assert.ok(result.changedFiles.includes("file1.ts"), "should include modified file");
    assert.ok(result.changedFiles.includes("newfile.ts"), "should include untracked file");
    assert.ok(!result.changedFiles.includes("file2.ts"), "should not include unchanged file");
    assert.ok(result.changedFiles.length >= 2, "should have at least 2 changed files");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

async function testCollectLocalChangesReturnsEmptyForCleanRepo() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-harness-review-only-clean-"));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GIT_DIR" && k !== "GIT_WORK_TREE"));
  const git = (...args) => execFileSync("git", args, { cwd: workdir, env: cleanEnv });

  try {
    git("init");
    writeFileSync(join(workdir, "readme.txt"), "clean\n", "utf8");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "init");

    const result = await withCleanGitEnv(() => harnessExecute.collectLocalChanges(workdir));
    assert.equal(result.changedFiles.length, 0, "clean repo should have no changed files");
    assert.equal(result.diffStat, "", "clean repo should have empty diff stat");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    cleanup();
  }
}

function testFormatReviewOnlyResultPass() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");

  try {
    const plan = {
      id: "review-20260408-abc123",
      originalRequest: "Review my changes",
      tasks: [{ id: "review-1", title: "Review my changes", scope: "/tmp/test", acceptanceCriteria: ["Review my changes"], agent: "codex" }],
      mode: "solo",
      estimatedComplexity: "low",
      tier: 0,
    };
    const workerResult = {
      taskId: "review-1",
      status: "completed",
      summary: "2 files changed",
      filesChanged: ["src/a.ts", "src/b.ts"],
      testsRun: 0,
      warnings: [],
    };
    const reviewResult = {
      taskId: "review-1",
      result: "pass",
      gaps: [],
      rerunNeeded: false,
    };
    const reviewLoop = { taskId: "review-1", currentLoop: 0, maxLoops: 4, gaps: [], passed: true, escalated: false, history: [reviewResult] };

    const output = harnessExecute.__formatReviewOnlyResultForTests(plan, workerResult, reviewResult, reviewLoop, "pass");
    assert.ok(output.includes("Review Only"), "should contain review-only header");
    assert.ok(output.includes("Pass"), "should indicate pass");
    assert.ok(output.includes("src/a.ts"), "should list changed files");
    assert.ok(output.includes("src/b.ts"), "should list changed files");
    assert.ok(output.includes("No gaps detected"), "should indicate no gaps");
  } finally {
    cleanup();
  }
}

function testFormatReviewOnlyResultWithGaps() {
  const { mod: harnessExecute, cleanup } = loadTsModule("src/tools/harness-execute.ts");

  try {
    const plan = {
      id: "review-20260408-xyz789",
      originalRequest: "Review my changes",
      tasks: [{ id: "review-1", title: "Review my changes", scope: "/tmp/test", acceptanceCriteria: ["Review my changes"], agent: "codex" }],
      mode: "solo",
      estimatedComplexity: "low",
      tier: 0,
    };
    const workerResult = {
      taskId: "review-1",
      status: "completed",
      summary: "1 file changed",
      filesChanged: ["src/c.ts"],
      testsRun: 0,
      warnings: [],
    };
    const reviewResult = {
      taskId: "review-1",
      result: "fail",
      gaps: [
        { type: "missing_core", evidence: "Unit tests not added", fixHint: "Add tests for the new function" },
      ],
      rerunNeeded: true,
    };
    const reviewLoop = { taskId: "review-1", currentLoop: 0, maxLoops: 4, gaps: reviewResult.gaps, passed: false, escalated: false, history: [reviewResult] };

    const output = harnessExecute.__formatReviewOnlyResultForTests(plan, workerResult, reviewResult, reviewLoop, "fix");
    assert.ok(output.includes("Gaps Found"), "should indicate gaps found");
    assert.ok(output.includes("missing_core"), "should include gap type");
    assert.ok(output.includes("Unit tests not added"), "should include gap evidence");
    assert.ok(output.includes("Add tests for the new function"), "should include fix hint");
    assert.ok(output.includes("src/c.ts"), "should list changed files");
  } finally {
    cleanup();
  }
}

const tests = [
  ["planner ignores return bullets", testPlannerIgnoresReturnBullets],
  ["planner groups standalone file bullets", testPlannerGroupsStandaloneFileBullets],
  ["model planner falls back to sonnet before succeeding", testModelPlannerFallsBackToSonnet],
  ["model planner falls back to heuristic after planner failures", testModelPlannerFallsBackToHeuristic],
  ["model planner merges implementation, tests, and verification", testModelPlannerMergesImplementationAndTests],
  ["reviewer backend selection routes GPT reviewer to Codex", testReviewerBackendSelection],
  ["claude model resolution normalizes canonical refs", testClaudeModelResolutionNormalizesCanonicalRefs],
  ["reviewer command uses Codex read-only path", testReviewerCommandUsesCodexReadOnlyPath],
  ["reviewer command sets Codex reasoning effort", testReviewerCommandSetsCodexReasoningEffort],
  ["planner JSON parser: parses fenced JSON with surrounding prose", testPlannerJsonParsesFencedJson],
  ["planner JSON parser: rejects invalid/missing JSON", testPlannerJsonRejectsInvalidJson],
  ["planner JSON parser: defaults and normalization", testPlannerJsonDefaultsAndNormalization],
  ["planner JSON parser: ignores prose outside fence", testPlannerJsonIgnoresProseOutsideFence],
  ["planner JSON parser: handles generic fence block", testExtractFencedJsonHandlesGenericFence],
  ["model planner uses JSON as primary parse path", testModelPlannerUsesJsonPrimary],
  ["extractFilePaths captures root and nested repo files", testExtractFilePathsCapturesRootAndNestedFiles],
  ["realtime harness defers transient plan_violation during round-complete", testHarnessDefersTransientPlanViolationDuringRoundComplete],
  ["realtime harness promotes later success after plan_violation", testHarnessPromotesLaterSuccessAfterPlanViolation],
  ["realtime harness reads success from stream when result file is missing", testHarnessReadsSuccessFromStreamWhenResultFileIsMissing],
  ["realtime checkpoint review modes route plan to embedded and waiting to codex", testRealtimeCheckpointReviewModes],
  ["realtime harness requires CLAUDE.md project context", testHarnessRequiresProjectContextBeforeRealtimeLaunch],
  ["checkpoint marks run failed when a task fails early", testCheckpointMarksFailedWhenTaskFailsEarly],
  ["checkpoint finds recoverable run for matching request and workdir", testFindRecoverableCheckpointMatchesRequestAndWorkdir],
  ["checkpoint finds recoverable run through symlinked workdir alias", testFindRecoverableCheckpointMatchesSymlinkedWorkdir],
  ["workspace isolation handles repos without HEAD commits", testWorkspaceIsolationHandlesUnbornHeadRepos],
  ["local-cc backend reuses completed execute output by jobId", testLocalCcBackendReusesCompletedExecuteOutput],
  ["local-cc backend reuses continue output and finalizes cleanly", testLocalCcBackendReusesContinueOutputAndFinalizes],
  ["session env prefers Claude credentials over gateway API key", testSessionPrefersClaudeCredentialsOverGatewayApiKey],
  ["local-cc args include Claude effort flag", testLocalCcArgsIncludeClaudeEffort],
  ["local-cc child env prefers Claude credentials over gateway API key", testLocalCcChildEnvPrefersClaudeCredentialsOverGatewayApiKey],
  ["local-cc backend reports missing claude CLI clearly", testLocalCcBackendReportsMissingCliClearly],
  ["local-cc workdir mismatch recovery migrates state", testLocalCcWorkdirMismatchRecovery],
  ["local-cc workdir mismatch recovery handles vanished old dir", testLocalCcWorkdirMismatchRecoveryVanishedOldDir],
  ["local-cc task mismatch still throws hard error", testLocalCcTaskMismatchStillThrows],
  ["review-only collectLocalChanges finds modified and untracked files", testCollectLocalChangesFindsModifiedFiles],
  ["review-only collectLocalChanges returns empty for clean repo", testCollectLocalChangesReturnsEmptyForCleanRepo],
  ["review-only formatResult shows pass with no gaps", testFormatReviewOnlyResultPass],
  ["review-only formatResult shows gaps found", testFormatReviewOnlyResultWithGaps],
];

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
