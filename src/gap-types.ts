import type { GapType } from "./types";

export interface GapDefinition {
  type: GapType;
  label: string;
  description: string;
  examples: string[];
}

export const GAP_DEFINITIONS: Record<GapType, GapDefinition> = {
  assumption_injection: {
    type: "assumption_injection",
    label: "Assumption Injection",
    description: "Added assumptions or decisions not present in the original request.",
    examples: [
      "Adding JWT authentication when not requested",
      "Choosing a specific database without being asked",
      "Adding rate limiting that wasn't in the spec",
    ],
  },
  scope_creep: {
    type: "scope_creep",
    label: "Scope Creep",
    description: "Added features or complexity beyond what was requested.",
    examples: [
      "Adding a notification system to a TODO app",
      "Building an admin dashboard when only asked for a form",
      "Adding i18n support for a single-language project",
    ],
  },
  direction_drift: {
    type: "direction_drift",
    label: "Direction Drift",
    description: "Implementation direction diverges from the original intent.",
    examples: [
      "Building a full-stack framework for a simple API",
      "Using microservices architecture for a CLI tool",
      "Converting a script to a full application",
    ],
  },
  missing_core: {
    type: "missing_core",
    label: "Missing Core",
    description: "Core functionality from the request was not implemented.",
    examples: [
      "Search feature not implemented in a search task",
      "Error handling omitted from API endpoint",
      "Missing validation on user input fields",
    ],
  },
  over_engineering: {
    type: "over_engineering",
    label: "Over-Engineering",
    description: "Excessive abstraction or generalization beyond what the task needs.",
    examples: [
      "DI container for simple CRUD operations",
      "Abstract factory pattern for a single implementation",
      "Generic middleware framework for one endpoint",
    ],
  },
};

export const REVIEWER_SYSTEM_PROMPT = `You are a code reviewer. Your job is to review code changes against the original task specification and acceptance criteria.

You must check for these 5 gap types:
${Object.values(GAP_DEFINITIONS)
  .map((g) => `- ${g.type}: ${g.description}`)
  .join("\n")}

Your ENTIRE response must be a single JSON object. No markdown, no explanation, no code blocks. Just the JSON.

Output schema:
{
  "taskId": "<task id>",
  "result": "pass" | "fail",
  "gaps": [
    {
      "type": "<gap type>",
      "evidence": "<specific evidence from the code>",
      "fixHint": "<concrete suggestion to fix>"
    }
  ],
  "rerunNeeded": true | false
}

Pass example:
{"taskId":"task-1","result":"pass","gaps":[],"rerunNeeded":false}

Fail example:
{"taskId":"task-1","result":"fail","gaps":[{"type":"missing_core","evidence":"The required --force flag is not implemented in the changed command.","fixHint":"Add --force handling and update the command validation path."}],"rerunNeeded":true}

Rules:
- You are READ-ONLY. Never modify code yourself.
- Only report gaps with concrete evidence from the code diff.
- "pass" means no gaps found. "fail" means at least one gap exists.
- Be strict on missing_core (required features). Be lenient on minor over_engineering.
- If the code fully satisfies the acceptance criteria with no gaps, result is "pass".`;
