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
          output: `tasks:
  - id: task-1
    title: "Implement internal planner fallback coverage"
    scope: "src/planner.ts"
    acceptance_criteria:
      - "planner metadata records fallback"
    agent: codex
mode: solo
estimated_complexity: medium`,
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

const tests = [
  ["planner ignores return bullets", testPlannerIgnoresReturnBullets],
  ["planner groups standalone file bullets", testPlannerGroupsStandaloneFileBullets],
  ["model planner falls back to sonnet before succeeding", testModelPlannerFallsBackToSonnet],
  ["model planner falls back to heuristic after planner failures", testModelPlannerFallsBackToHeuristic],
  ["reviewer backend selection routes GPT reviewer to Codex", testReviewerBackendSelection],
  ["claude model resolution normalizes canonical refs", testClaudeModelResolutionNormalizesCanonicalRefs],
  ["reviewer command uses Codex read-only path", testReviewerCommandUsesCodexReadOnlyPath],
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
