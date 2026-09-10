import type { ManifestEntry } from "../lib/scenario-filter.js";

export const SCENARIO_MANIFEST: ManifestEntry[] = [
  { id: "answer-check-creation", tier: "live", module: "answer-check-creation" },
  { id: "turn-basic-wellness", tier: "replay", module: "turn-basic-wellness" },
  { id: "turn-multistep-activities", tier: "replay", module: "turn-multistep-activities" },
  { id: "turn-write-workout", tier: "replay", module: "turn-write-workout" },
  { id: "session-stale-reset-flush", tier: "replay", module: "session-stale-reset-flush" },
  { id: "session-trim-compaction", tier: "replay", module: "session-trim-compaction" },
  { id: "multi-turn-memory", tier: "replay", module: "multi-turn-memory" },
  { id: "inj-01", tier: "replay", module: "inj-01" },
  { id: "inj-02", tier: "replay", module: "inj-02" },
  { id: "inj-03", tier: "replay", module: "inj-03" },
  { id: "inj-04", tier: "replay", module: "inj-04" },
  { id: "inj-05", tier: "replay", module: "inj-05" },
];
