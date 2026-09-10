// Sport shape with NO per-sport adapter seam — `referenceAdapters` is absent
// entirely. Exercises the dispatcher's "sport declares no adapters" branch
// (the method is optional, so `referenceAdapters` is `undefined`, not `[]`).
import type { IntervalsActivityType, Sport } from "../../../../src/index.js";

export const noAdapterShape: Pick<Sport, "id" | "intervalsActivityTypes" | "referenceAdapters"> = {
  id: "running",
  intervalsActivityTypes: ["Run", "TrailRun"] as readonly IntervalsActivityType[],
  // referenceAdapters intentionally omitted.
};
