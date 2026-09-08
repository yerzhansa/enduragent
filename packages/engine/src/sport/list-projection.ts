const WELLNESS_FIELDS = new Set([
  "id",
  "ctl",
  "atl",
  "rampRate",
  "weight",
  "restingHR",
  "hrv",
  "sleepSecs",
  "sleepScore",
  "readiness",
  "sportInfo",
  "sleepQuality",
  "fatigue",
  "stress",
  "mood",
  "motivation",
  "soreness",
  "injury",
]);

const ACTIVITY_FIELDS = new Set([
  "id",
  "startDateLocal",
  "type",
  "name",
  "movingTime",
  "distance",
  "icuTrainingLoad",
  "icuIntensity",
  "averageWatts",
  "icuWeightedAvgWatts",
  "averageHeartrate",
  "maxHeartrate",
  "icuFtp",
  "totalElevationGain",
]);

function projectFields(row: object, fields: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) => fields.has(key) && value !== null && value !== undefined,
    ),
  );
}

export function projectWellness(row: unknown): Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return {};
  const projected = projectFields(row, WELLNESS_FIELDS);
  if (!Array.isArray(projected.sportInfo) || projected.sportInfo.length === 0) {
    delete projected.sportInfo;
  }
  return projected;
}

export function projectActivity(row: unknown): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return {};
  if ("localDate" in row && "sessionSequence" in row) return row;
  return projectFields(row, ACTIVITY_FIELDS);
}
