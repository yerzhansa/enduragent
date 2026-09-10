// Composing sport with TWO adapters whose activity-type coverage is DISJOINT —
// the valid multi-adapter case. The cycling adapter claims the ride types, the
// running adapter claims the run types; their union is a subset of
// `intervalsActivityTypes` and no type is claimed twice. Exercises the
// dispatcher's fan-out across more than one adapter.
import type { IntervalsActivityType, ReferenceSportAdapter, Sport } from "../../../../src/index.js";

const cyclingAdapter: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 600, 1200, 1800, 3600, 5400, 7200],
  dfaValidated: true,
  anchorType: "ftp",
};

const runningAdapter: ReferenceSportAdapter = {
  activityTypes: ["Run", "TrailRun"],
  zoneBasis: "pace",
  decouplingBasis: "pace",
  sustainabilityAnchors: [],
  dfaValidated: false,
  anchorType: "critical-speed",
};

export const twoAdapterDuathlonShape: Pick<
  Sport,
  "id" | "intervalsActivityTypes" | "referenceAdapters"
> = {
  id: "duathlon",
  intervalsActivityTypes: [
    "Ride",
    "VirtualRide",
    "Run",
    "TrailRun",
  ] as readonly IntervalsActivityType[],
  referenceAdapters: (): readonly ReferenceSportAdapter[] => [cyclingAdapter, runningAdapter],
};
