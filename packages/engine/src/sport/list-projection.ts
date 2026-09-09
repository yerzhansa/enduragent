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
  "source",
]);

const ATHLETE_FIELDS = new Set([
  "icuFtp",
  "maxHr",
  "icuRestingHr",
  "icuWeight",
  "weight",
  "height",
  "sex",
  "icuDateOfBirth",
  "dateOfBirth",
  "sportSettings",
]);

const SPORT_SETTINGS_FIELDS = new Set([
  "types",
  "ftp",
  "indoorFtp",
  "indoor_ftp",
  "lthr",
  "maxHr",
  "max_hr",
  "restingHr",
  "weight",
  "wPrime",
  "w_prime",
  "pMax",
  "p_max",
  "thresholdPace",
  "threshold_pace",
  "paceUnits",
  "pace_units",
  "powerZones",
  "power_zones",
  "powerZoneNames",
  "power_zone_names",
  "hrZones",
  "hr_zones",
  "hrZoneNames",
  "hr_zone_names",
  "sweetSpotMin",
  "sweet_spot_min",
  "sweetSpotMax",
  "sweet_spot_max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectFields(row: object, fields: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) => fields.has(key) && value !== null && value !== undefined,
    ),
  );
}

export function projectAthlete(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {};
  const projected = projectFields(row, ATHLETE_FIELDS);
  if (Array.isArray(projected.sportSettings)) {
    projected.sportSettings = projected.sportSettings.map((settings: unknown) =>
      isRecord(settings) ? projectFields(settings, SPORT_SETTINGS_FIELDS) : {},
    );
  } else {
    delete projected.sportSettings;
  }
  return projected;
}

export function projectWellness(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) return {};
  const projected = projectFields(row, WELLNESS_FIELDS);
  if (!Array.isArray(projected.sportInfo) || projected.sportInfo.length === 0) {
    delete projected.sportInfo;
  }
  return projected;
}

export function projectActivity(row: unknown): unknown {
  if (!isRecord(row)) return {};
  if ("localDate" in row && "sessionSequence" in row) return row;
  return projectFields(row, ACTIVITY_FIELDS);
}
