import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  MemoryStorePort,
  PlatformCalendarMutationsPort,
} from "@enduragent/engine/sport";
import type { IntervalsClient } from "intervals-icu-api";
import {
  buildSystemPrompt,
  splitSystemPromptAtBoundary,
} from "../../engine/src/agent/system-prompt.js";
import { estimateTokens } from "../../engine/src/agent/token-utils.js";
import {
  CYCLING_PRESCRIPTION_CAPABILITY,
  type PrescriptionCapability,
} from "../src/prescription-posture.js";
import { cyclingSport } from "../src/sport.js";
import { createCyclingTools } from "../src/tools.js";

const capabilityPath = fileURLToPath(new URL("../src/prescription-posture.ts", import.meta.url));
const sportPath = fileURLToPath(new URL("../src/sport.ts", import.meta.url));
const toolsPath = fileURLToPath(new URL("../src/tools.ts", import.meta.url));

const expectedCapabilitySource = `export type PrescriptionCapability<EnvelopeValues> =
  | Readonly<{
      envelopeAuthorship: "unauthored";
      autonomousWorkoutProposals: "unavailable";
      envelopeValues: null;
      promptSkillKey: string;
      toolSelectionRule: string;
    }>
  | Readonly<{
      envelopeAuthorship: "authored";
      autonomousWorkoutProposals: "available";
      envelopeValues: EnvelopeValues;
      promptSkillKey: string;
      toolSelectionRule: string;
    }>;

export const CYCLING_PRESCRIPTION_CAPABILITY = {
  envelopeAuthorship: "unauthored",
  autonomousWorkoutProposals: "unavailable",
  envelopeValues: null,
  promptSkillKey: "cycling-prescription-posture",
  toolSelectionRule:
    "Call this only when the current message explicitly asks for it; see the Cycling Prescription Availability skill.",
} as const satisfies PrescriptionCapability<never>;
`;

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function collectNodes(source: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
}

function hasAncestor(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (predicate(current)) return true;
  }
  return false;
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

const memory: MemoryStorePort = {
  readMemory: () => "",
  writeSection: () => undefined,
  readSection: () => null,
  renameSection: () => "noop",
  renameSections: (renames) => renames.map(() => "noop"),
  readDailyNotes: () => "",
  appendDailyNote: () => undefined,
  readDailyNotesInRange: () => [],
  readEventsRaw: () => "",
  readJournalRaw: () => "",
  appendEvent: () => true,
  savePlan: () => undefined,
  loadPlan: () => null,
  reload: () => undefined,
  getContext: () => "",
};

const intervals = {} as IntervalsClient;

const calendarMutations: PlatformCalendarMutationsPort = {
  createEvent: async () => ({}),
  readEventForDelete: async ({ eventId }) => ({ id: eventId, startDateLocal: "2000-01-01" }),
  updateEvent: async () => ({}),
  deleteEvent: async () => ({}),
};

describe("cycling prescription posture", () => {
  it("exposes disabled metadata in a data-only source file", () => {
    expect(CYCLING_PRESCRIPTION_CAPABILITY).toEqual({
      envelopeAuthorship: "unauthored",
      autonomousWorkoutProposals: "unavailable",
      envelopeValues: null,
      promptSkillKey: "cycling-prescription-posture",
      toolSelectionRule:
        "Call this only when the current message explicitly asks for it; see the Cycling Prescription Availability skill.",
    });
    expect(CYCLING_PRESCRIPTION_CAPABILITY.envelopeValues).toBeNull();
    expect(readFileSync(capabilityPath, "utf8")).toBe(expectedCapabilitySource);

    const source = parseSource(capabilityPath);
    const forbidden = collectNodes(
      source,
      (node) =>
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isRegularExpressionLiteral(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isImportDeclaration(node),
    );
    expect(forbidden).toEqual([]);
  });

  it("maps capability metadata to the always-visible cycling skill", () => {
    expect(cyclingSport.prescriptionCapability).toBe(CYCLING_PRESCRIPTION_CAPABILITY);
    const skill = cyclingSport.skills[cyclingSport.prescriptionCapability.promptSkillKey];
    expect(skill).toBeDefined();
    expect(skill).toContain("# Cycling Prescription Availability");
    expect(skill).toContain("Judge each request anew");
    expect(skill).toContain("prose and tool calls");
    expect(skill).toContain("current message");
  });

  it("keeps the posture once in the stable prompt prefix below the token ceiling", () => {
    const emptyMemory = { getContext: () => "" } as Parameters<typeof buildSystemPrompt>[1];
    const prompt = buildSystemPrompt(cyclingSport, emptyMemory);
    const blocks = splitSystemPromptAtBoundary(prompt);
    expect(blocks).toBeDefined();
    if (blocks === undefined) throw new TypeError("missing system prompt cache boundary");
    const { prefix, volatile } = blocks;
    expect(prefix.match(/## Skill: cycling-prescription-posture/g)).toHaveLength(1);
    expect(volatile.match(/## Skill: cycling-prescription-posture/g)).toBeNull();
    expect(estimateTokens(prompt)).toBeLessThan(13_200);
  });

  it("retains requested prescription tools with selection-only capability references", () => {
    const withCalendar = createCyclingTools(memory, intervals, "UTC", calendarMutations);
    for (const name of [
      "build_plan_skeleton",
      "get_sample_week",
      "intervals_create_workout",
    ] as const) {
      expect(withCalendar[name]).toBeDefined();
      expect(withCalendar[name]?.description).toBeDefined();
      expect(
        withCalendar[name]?.description?.startsWith(
          CYCLING_PRESCRIPTION_CAPABILITY.toolSelectionRule,
        ),
      ).toBe(true);
    }

    const withoutCalendar = createCyclingTools(memory, null);
    expect(withoutCalendar.build_plan_skeleton).toBeDefined();
    expect(withoutCalendar.get_sample_week).toBeDefined();
    expect(withoutCalendar.calculate_zones).toBeDefined();
    expect(withoutCalendar.assess_feasibility).toBeDefined();
    expect(withoutCalendar.intervals_create_workout).toBeUndefined();

    const toolsSource = parseSource(toolsPath);
    const toolsOccurrences = collectNodes(
      toolsSource,
      (node) => ts.isIdentifier(node) && node.text === "CYCLING_PRESCRIPTION_CAPABILITY",
    );
    const importOccurrences = toolsOccurrences.filter((node) =>
      hasAncestor(node, ts.isImportDeclaration),
    );
    const selectionOccurrences = toolsOccurrences.filter(
      (node) => !hasAncestor(node, ts.isImportDeclaration),
    );
    expect(importOccurrences).toHaveLength(1);
    expect(selectionOccurrences).toHaveLength(3);
    for (const occurrence of selectionOccurrences) {
      expect(
        hasAncestor(
          occurrence,
          (node) => ts.isPropertyAssignment(node) && node.name.getText() === "description",
        ),
      ).toBe(true);
      expect(
        hasAncestor(
          occurrence,
          (node) =>
            ts.isPropertyAssignment(node) &&
            ["execute", "inputSchema"].includes(node.name.getText()),
        ),
      ).toBe(false);
      const conditionals = collectNodes(toolsSource, ts.isConditionalExpression) as ts.ConditionalExpression[];
      expect(conditionals.some((conditional) => isWithin(occurrence, conditional.condition))).toBe(false);
    }

    const sportSource = parseSource(sportPath);
    const sportOccurrences = collectNodes(
      sportSource,
      (node) => ts.isIdentifier(node) && node.text === "CYCLING_PRESCRIPTION_CAPABILITY",
    );
    expect(sportOccurrences.filter((node) => hasAncestor(node, ts.isImportDeclaration))).toHaveLength(1);
    expect(
      sportOccurrences.filter((node) =>
        hasAncestor(
          node,
          (candidate) =>
            ts.isPropertyAssignment(candidate) &&
            candidate.name.getText() === "prescriptionCapability",
        ),
      ),
    ).toHaveLength(1);
    expect(
      sportOccurrences.filter((node) =>
        hasAncestor(node, (candidate) => ts.isTypeQueryNode(candidate)),
      ),
    ).toHaveLength(1);

    const cyclingObject = collectNodes(
      sportSource,
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "cyclingSport",
    )[0] as ts.VariableDeclaration;
    const objectLiteral = collectNodes(cyclingObject.initializer!, ts.isObjectLiteralExpression)[0] as ts.ObjectLiteralExpression;
    const propertyNames = objectLiteral.properties.map((property) => property.name?.getText());
    expect(propertyNames.indexOf("prescriptionCapability")).toBe(propertyNames.indexOf("skills") + 1);
  });

  it("keeps the authored branch activation-compatible", () => {
    type FutureEnvelope = Readonly<{ futureValues: "opaque" }>;
    const futureCapability: PrescriptionCapability<FutureEnvelope> = {
      envelopeAuthorship: "authored",
      autonomousWorkoutProposals: "available",
      envelopeValues: { futureValues: "opaque" },
      promptSkillKey: "cycling-prescription-posture",
      toolSelectionRule: "future selection rule",
    };
    expectTypeOf(futureCapability.envelopeValues).toEqualTypeOf<FutureEnvelope>();
  });
});
