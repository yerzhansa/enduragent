// Sport shape that implements `referenceAdapters` but returns an EMPTY array.
// Exercises the dispatcher's "method present, zero adapters" branch — distinct
// from the absent-method case: the union of adapter coverage is empty, which is
// a vacuously-valid subset of `intervalsActivityTypes`.
import type { IntervalsActivityType, ReferenceSportAdapter, Sport } from "../../../../src/index.js";

export const emptyArrayShape: Pick<Sport, "id" | "intervalsActivityTypes" | "referenceAdapters"> = {
  id: "running",
  intervalsActivityTypes: ["Run", "TrailRun"] as readonly IntervalsActivityType[],
  referenceAdapters: (): readonly ReferenceSportAdapter[] => [],
};
