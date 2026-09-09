import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLAN_QA_SCENARIOS,
  createPlanQaSeedModel,
  planQaSeedScenarioId,
} from "../../../apps/desktop/tests/helpers/plan-qa-scenario-registry.js";
import { PLAN_TRANSITION_IDS, PlanScenarioIdSchema } from "../src/planning.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const currentFile = relative(repositoryRoot, fileURLToPath(import.meta.url));

function scenarioId(value: number): string {
  return `PL-S${String(value).padStart(3, "0")}`;
}

function scenarioRange(start: number, end: number): string[] {
  return Array.from({ length: end - start + 1 }, (_, index) => scenarioId(start + index));
}

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function collectTestFiles(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["dist", "node_modules", "out"].includes(entry.name))
        paths.push(...collectTestFiles(path));
      continue;
    }
    if (/\.test\.(?:ts|tsx)$/.test(entry.name) && path !== currentFile) paths.push(path);
  }
  return paths;
}

const evidenceGroups = [
  {
    scenarios: [scenarioId(1), scenarioId(11), scenarioId(28)],
    evidence: [
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "renders the no-Plan hierarchy and starts Plan creation from the keyboard",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "renders the server attention projection without deriving a count",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "uses production token classes for wide, compact, Light, and Dark layouts",
      ],
    ],
  },
  {
    scenarios: [
      scenarioId(2),
      scenarioId(3),
      ...scenarioRange(15, 20),
      ...scenarioRange(29, 31),
      ...scenarioRange(44, 50),
      ...scenarioRange(57, 70),
      ...scenarioRange(103, 105),
    ],
    evidence: [
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "keeps the Coach interview inside Plan and offers Draft creation when ready",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "keeps Race Course selection and recovery inside the Plan surface",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "resolves FTP with one compact whole-watts control and an Intervals refresh",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "confirms Draft discard with Cancel focused before the destructive action",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "uses a compact keyboard date picker and confirms a shorter valid block",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "returns a revised Draft to review and exposes the approval command",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "keeps a failed start-date recalculation visible with both recovery choices",
      ],
      [
        "packages/coach/tests/planning-operations.test.ts",
        "keeps the current Plan active until an atomic replacement and blocks new writes until cleanup",
      ],
    ],
  },
  {
    scenarios: [
      scenarioId(4),
      scenarioId(10),
      scenarioId(13),
      scenarioId(21),
      ...scenarioRange(32, 43),
    ],
    evidence: [
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "keeps reconciliation failures inline on the active Plan with retry and verify actions",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "highlights WorkoutMatch decisions and keeps drawer actions visible",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "shows the outside-edit comparison and exposes explicit adopt or restore choices",
      ],
      [
        "packages/coach/tests/planning-operations.test.ts",
        "hydrates an interrupted reconciliation as crash-resume work without attention",
      ],
    ],
  },
  {
    scenarios: [
      scenarioId(5),
      scenarioId(7),
      scenarioId(8),
      ...scenarioRange(22, 27),
      ...scenarioRange(90, 93),
      scenarioId(97),
      scenarioId(100),
      scenarioId(101),
    ],
    evidence: [
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "renders structured Proposal diffs, read-only evidence, and explicit decisions",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "renders connected Plan history and the applied, expired, and undone destinations",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "saves Plan settings per control and shows an automatic reduction as one result",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "shows the delivered Weekly review inside Plan without a response composer",
      ],
    ],
  },
  {
    scenarios: [
      scenarioId(14),
      ...scenarioRange(51, 56),
      ...scenarioRange(79, 89),
      ...scenarioRange(94, 96),
      scenarioId(102),
    ],
    evidence: [
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "confirms End Plan with Cancel focused and keeps failed cleanup recoverable",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "shows natural completion, records the race outcome, and preserves the ended Plan",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "keeps replacement confirmation safe and cleanup recovery explicit",
      ],
      [
        "packages/kernel-node/tests/plan-conversation-repository.test.ts",
        "makes ended conversations read-only and prevents reopening",
      ],
    ],
  },
  {
    scenarios: [
      scenarioId(6),
      scenarioId(9),
      scenarioId(12),
      ...scenarioRange(71, 78),
      scenarioId(98),
    ],
    evidence: [
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "renders the complete Season and authoritative Race week at compact-safe widths",
      ],
      [
        "apps/desktop-renderer/tests/plan-surface.test.tsx",
        "renders every Race readiness state and returns focus to its active-Plan trigger",
      ],
      [
        "packages/sport-cycling/tests/estimated-cp.test.ts",
        "selects one eligible effort in each band and rounds only the visible value",
      ],
    ],
  },
] as const;

const canonicalFlows = [
  {
    name: "Discard Draft",
    transitions: ["PL-T10", "PL-T05"],
    evidence: [
      "apps/desktop-renderer/tests/plan-surface.test.tsx",
      "confirms Draft discard with Cancel focused before the destructive action",
    ],
  },
  {
    name: "Adjustment, provenance, apply, Undo",
    transitions: ["PL-T13", "PL-T17", "PL-T18", "PL-T19", "PL-T21"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "routes a structured Proposal through review, provenance, revision, and approval",
    ],
  },
  {
    name: "Calendar reconciliation",
    transitions: ["PL-T11", "PL-T12"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "activates locally before an idempotent seven-day Intervals reconciliation",
    ],
  },
  {
    name: "Start-date recalculation",
    transitions: ["PL-T08"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "recalculates a valid start date and keeps the previous Draft on invalid or failed dates",
    ],
  },
  {
    name: "End Plan and cleanup",
    transitions: ["PL-T23", "PL-T24"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "ends locally, preserves today and athlete events, and recovers cleanup",
    ],
  },
  {
    name: "Missing FTP",
    transitions: ["PL-T04", "PL-T06"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "resolves manual and Intervals FTP sources before returning to the Plan coach",
    ],
  },
  {
    name: "Race Course recalculation",
    transitions: ["PL-T02", "PL-T09"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "recalculates a Draft atomically and rejects Course edits after activation",
    ],
  },
  {
    name: "Estimated CP evidence",
    transitions: ["PL-T32"],
    evidence: [
      "packages/sport-cycling/tests/estimated-cp.test.ts",
      "selects one eligible effort in each band and rounds only the visible value",
    ],
  },
  {
    name: "Replacement Plan",
    transitions: ["PL-T25", "PL-T26", "PL-T27", "PL-T28"],
    evidence: [
      "packages/coach/tests/planning-operations.test.ts",
      "keeps the current Plan active until an atomic replacement and blocks new writes until cleanup",
    ],
  },
] as const;

describe("Plan acceptance closure", () => {
  it("assigns every Plan-owned Scenario to executable acceptance evidence", () => {
    const expected = scenarioRange(1, 105).filter((id) => id !== "PL-S099");
    const actual = PLAN_QA_SCENARIOS.map((entry) => entry.id);

    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual(expected.sort());
    for (const entry of PLAN_QA_SCENARIOS) {
      expect(PlanScenarioIdSchema.parse(entry.id)).toBe(entry.id);
      expect(createPlanQaSeedModel(entry.id).scenarioId).toBe(planQaSeedScenarioId(entry.id));
    }
  });

  it("retains executable evidence for every Plan-owned transition and canonical flow", () => {
    const testCorpus = [...collectTestFiles("apps"), ...collectTestFiles("packages")]
      .map(readRepositoryFile)
      .join("\n");
    const planOwnedTransitions = PLAN_TRANSITION_IDS.filter(
      (id) => id !== "PL-T36" && id !== "PL-T37",
    );

    for (const id of planOwnedTransitions)
      expect(testCorpus, `${id} needs test evidence`).toContain(id);
    expect(canonicalFlows).toHaveLength(9);
    for (const flow of canonicalFlows) {
      const [path, marker] = flow.evidence;
      expect(flow.transitions.every((id) => planOwnedTransitions.includes(id))).toBe(true);
      expect(readRepositoryFile(path), `${flow.name} must retain ${marker}`).toContain(marker);
    }
  });

  it("keeps prototype harness controls out while retaining real recovery actions", () => {
    const productionCorpus = [
      "apps/desktop-renderer/src/ui/plan/PlanView.tsx",
      "apps/desktop-renderer/src/state/adapters/plan.ts",
      "apps/desktop-renderer/src/app/views.ts",
      "packages/i18n/catalogs/en.json",
    ]
      .map(readRepositoryFile)
      .join("\n");

    for (const excluded of [
      "Screen or state",
      "Show failure",
      "Finish update",
      "Resume after restart",
      "data-flow-step",
      "data-prototype-control",
    ]) {
      expect(productionCorpus).not.toContain(excluded);
    }
    for (const productAction of ["Retry", "Verify again", "Cancel"]) {
      expect(productionCorpus).toContain(productAction);
    }
  });

  it("retains keyboard, focus, visual-matrix, and Estimated CP evidence", () => {
    const surfaceEvidence = readRepositoryFile("apps/desktop-renderer/tests/plan-surface.test.tsx");
    const cpEvidence = readRepositoryFile("packages/sport-cycling/tests/estimated-cp.test.ts");

    for (const marker of [
      "starts Plan creation from the keyboard",
      "Cancel focused before the destructive action",
      "returns focus to its active-Plan trigger",
      "wide, compact, Light, and Dark layouts",
      "About Estimated CP",
      "3:00 at 407 W",
      "15:00 at 311 W",
    ]) {
      expect(surfaceEvidence).toContain(marker);
    }
    expect(cpEvidence).toContain("averagePowerW: 407");
    expect(cpEvidence).toContain("averagePowerW: 311");
  });

  it("leaves the transferred Chat handoff outside Plan-owned closure", () => {
    const scenarios = evidenceGroups.flatMap((group) => group.scenarios);
    const transitions = canonicalFlows.flatMap((flow) => flow.transitions);

    expect(scenarios).not.toContain("PL-S099");
    expect(transitions).not.toContain("PL-T36");
    expect(transitions).not.toContain("PL-T37");
  });
});
