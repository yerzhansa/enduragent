import { z } from "zod";
import {
  createCoreToolsWithSportConfig,
  createMemoryTools,
  createPureCoreIntervalsTools,
  getEffectiveSections,
  type CoreDeps,
  type MemorySectionSpec,
  type MemorySnapshot,
  type ReferenceSportAdapter,
  type Sport,
  type ToolRegistration,
} from "@enduragent/engine/sport";
import soul from "../SOUL.md";
import { CYCLING_PRESCRIPTION_CAPABILITY } from "./prescription-posture.js";
import { skills as skillEntries } from "./skills.generated.js";
import { createCyclingTools } from "./tools.js";
import { cyclingReferenceAdapter } from "./reference/index.js";
import { athleteProfileSchema } from "./schemas.js";
import { cyclingWorkoutPreparation } from "./workout-change-set-tool.js";

function loadSkills(): Record<string, string> {
  return Object.fromEntries(skillEntries.map(({ name, content }) => [`cycling-${name}`, content]));
}

const cyclingSkills = loadSkills();

export const CYCLING_VOCABULARY: readonly string[] = [
  "FTP",
  "W/kg",
  "Coggan",
  "VO2max",
  "watts",
  "sweet spot",
  "TTE",
];

const memorySections: readonly MemorySectionSpec[] = [
  {
    name: "cycling-profile",
    description:
      "FTP (watts), max HR, resting HR, W/kg ratio, experience level. " +
      "Body data lives in `person`; this is cycling-specific physiology.",
    hint: "FTP, max/resting HR, W/kg, experience level",
    inject: true,
  },
  {
    name: "cycling-equipment",
    description: "Bikes, trainer, power meter, head unit, indoor setup",
    hint: "bikes, trainer, power meter, sensors",
    inject: false,
  },
  {
    name: "cycling-history",
    description:
      "Cycling-specific injuries (knee, lower back, fit issues), FTP test history, " +
      "recovery patterns from rides, ride-related sleep/HRV trends. " +
      "Chronic conditions belong in `medical-history`, not here.",
    hint: "cycling injuries, FTP test history, ride recovery patterns",
    inject: false,
  },
];

export const cyclingSport = {
  id: "cycling",
  soul,
  skills: cyclingSkills,
  prescriptionCapability: CYCLING_PRESCRIPTION_CAPABILITY,
  workoutPreparation: cyclingWorkoutPreparation,
  sessionClusterGapMinutes: 30,
  memorySections,
  mustPreserveTokens: (memory: MemorySnapshot) => {
    const tokens: string[] = [...CYCLING_VOCABULARY];
    const profile = memory.read("cycling-profile");
    if (profile) {
      // \bFTP\b prevents matching "SoftPlate" etc. Separator class accepts FTP 247,
      // FTP: 247, FTP, 247, FTP - 247. Unit optional. Digit range 2-3 (50-999W)
      // rejects 4-digit year collisions like "FTP test 2024-06: 240W" → matches 240,
      // not 2024. Trailing \b ensures we don't capture "FTP 247abc". First match
      // only — historical FTPs aren't identity-defining and would balloon
      // false-positive surface.
      const match = profile.match(/\bFTP\b[\s:,-]*(\d{2,3})\s*[wW]?\b/);
      if (match) {
        tokens.push(`FTP ${match[1]}W`);
        return { tokens, provenance: memory.provenanceOf("cycling-profile") };
      }
    }
    return tokens;
  },
  intervalsActivityTypes: ["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide"],
  athleteProfileSchema,
  tools: (deps: CoreDeps): readonly ToolRegistration[] => {
    const sections = getEffectiveSections(cyclingSport);
    // Per ADR-0004: compose four tool buckets — memory (Pure-Core),
    // intervals Pure-Core, intervals Core-with-sport-config, and the
    // sport-specific cycling tools.
    const toolset = {
      ...createMemoryTools(deps.memory, sections, {
        bindProvenance: deps.bindMemoryToolProvenance,
      }),
      ...createPureCoreIntervalsTools(
        deps.intervals,
        deps.tz,
        deps.athleteData,
        deps.calendarMutations,
      ),
      ...createCoreToolsWithSportConfig(
        deps.intervals,
        cyclingSport.intervalsActivityTypes,
        deps.athleteData,
      ),
      ...createCyclingTools(deps.memory, deps.intervals, deps.tz, deps.calendarMutations),
    };
    return Object.entries(toolset).map(([name, t]) => ({
      name,
      description: (t as { description?: string }).description ?? "",
      // Vercel AI SDK wraps the Zod schema into a FlexibleSchema that
      // doesn't expose the raw ZodTypeAny; introspection lives on `tool`.
      inputSchema: z.unknown(),
      tool: t,
    }));
  },
  // Fresh array per call so composing sports can spread it without sharing a
  // mutable reference.
  referenceAdapters: (): readonly ReferenceSportAdapter[] => [cyclingReferenceAdapter],
} satisfies Sport & {
  readonly prescriptionCapability: typeof CYCLING_PRESCRIPTION_CAPABILITY;
};
