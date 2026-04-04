const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join, resolve } = require("node:path");
const esbuild = require("esbuild");

const ROOT = resolve(__dirname, "..");

function loadTsModule(relativePath) {
  const entry = resolve(ROOT, relativePath);
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-harness-test-"));
  const outfile = join(tempDir, basename(relativePath).replace(/\.ts$/, ".cjs"));

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
    ].join("\n");

    const files = harnessExecute.extractFilePaths(output);
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

const tests = [
  ["planner ignores return bullets", testPlannerIgnoresReturnBullets],
  ["planner groups standalone file bullets", testPlannerGroupsStandaloneFileBullets],
  ["model planner falls back to sonnet before succeeding", testModelPlannerFallsBackToSonnet],
  ["model planner falls back to heuristic after planner failures", testModelPlannerFallsBackToHeuristic],
  ["reviewer backend selection routes GPT reviewer to Codex", testReviewerBackendSelection],
  ["claude model resolution normalizes canonical refs", testClaudeModelResolutionNormalizesCanonicalRefs],
  ["reviewer command uses Codex read-only path", testReviewerCommandUsesCodexReadOnlyPath],
  ["planner JSON parser: parses fenced JSON with surrounding prose", testPlannerJsonParsesFencedJson],
  ["planner JSON parser: rejects invalid/missing JSON", testPlannerJsonRejectsInvalidJson],
  ["planner JSON parser: defaults and normalization", testPlannerJsonDefaultsAndNormalization],
  ["planner JSON parser: ignores prose outside fence", testPlannerJsonIgnoresProseOutsideFence],
  ["planner JSON parser: handles generic fence block", testExtractFencedJsonHandlesGenericFence],
  ["model planner uses JSON as primary parse path", testModelPlannerUsesJsonPrimary],
  ["extractFilePaths captures root and nested repo files", testExtractFilePathsCapturesRootAndNestedFiles],
  ["checkpoint marks run failed when a task fails early", testCheckpointMarksFailedWhenTaskFailsEarly],
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
