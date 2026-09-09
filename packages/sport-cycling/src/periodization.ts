import type {
  ExperienceLevel,
  VolumeTier,
  RaceType,
  CycleFocus,
  AthleteProfile,
} from "./schemas.js";

// ============================================================================
// PERIODIZATION MODEL
// ============================================================================

export type PeriodizationModel = "linear" | "block" | "reverse_linear" | "polarized" | "pyramidal";

// ============================================================================
// BUILD:RECOVERY RATIOS
// ============================================================================

export const BUILD_RECOVERY_RATIOS: Record<ExperienceLevel, { build: number; recovery: number }> = {
  beginner: { build: 2, recovery: 1 },
  intermediate: { build: 3, recovery: 1 },
  advanced: { build: 3, recovery: 1 },
  elite: { build: 4, recovery: 1 },
};

// ============================================================================
// TAPER WEEKS BY RACE TYPE
// ============================================================================

export const TAPER_WEEKS: Record<RaceType, number> = {
  century: 2,
  gran_fondo: 2,
  criterium: 1,
  time_trial: 1,
  other: 1,
};

// ============================================================================
// DEFAULT TOTAL WEEKS
// ============================================================================

export const DEFAULT_TOTAL_WEEKS_BY_RACE: Record<RaceType, number> = {
  century: 12,
  gran_fondo: 12,
  criterium: 8,
  time_trial: 8,
  other: 10,
};

export const DEFAULT_TOTAL_WEEKS_BY_EXPERIENCE: Record<ExperienceLevel, number> = {
  beginner: 8,
  intermediate: 12,
  advanced: 16,
  elite: 16,
};

// ============================================================================
// PHASE TEMPLATES
// ============================================================================

export interface PhaseTemplate {
  focus: CycleFocus;
  pct: number;
}

export const PHASE_TEMPLATES: Record<PeriodizationModel, PhaseTemplate[]> = {
  linear: [
    { focus: "base_building", pct: 0.45 },
    { focus: "threshold", pct: 0.35 },
    { focus: "race_prep", pct: 0.2 },
  ],
  block: [
    { focus: "aerobic_development", pct: 0.3 },
    { focus: "threshold", pct: 0.3 },
    { focus: "vo2max", pct: 0.25 },
    { focus: "race_prep", pct: 0.15 },
  ],
  reverse_linear: [
    { focus: "vo2max", pct: 0.45 },
    { focus: "aerobic_development", pct: 0.35 },
    { focus: "race_prep", pct: 0.2 },
  ],
  polarized: [
    { focus: "aerobic_development", pct: 0.4 },
    { focus: "base_building", pct: 0.35 },
    { focus: "threshold", pct: 0.25 },
  ],
  pyramidal: [
    { focus: "base_building", pct: 0.35 },
    { focus: "aerobic_development", pct: 0.3 },
    { focus: "threshold", pct: 0.2 },
    { focus: "race_prep", pct: 0.15 },
  ],
};

// ============================================================================
// VOLUME PROGRESSION MULTIPLIERS
// ============================================================================

export const VOLUME_PROGRESSION: Record<string, number> = {
  base: 1.0,
  build: 1.1,
  peak: 1.15,
  taper: 0.6,
  recovery: 0.7,
};

// ============================================================================
// INTENSITY DISTRIBUTIONS BY FOCUS
// ============================================================================

export const INTENSITY_DISTRIBUTIONS: Record<string, string> = {
  base_building: "85% easy / 10% tempo / 5% threshold",
  aerobic_development: "80% easy / 15% tempo / 5% threshold",
  threshold: "70% easy / 20% threshold / 10% VO2max",
  vo2max: "65% easy / 15% threshold / 20% VO2max",
  race_prep: "60% easy / 25% race-pace / 15% VO2max",
  taper: "85% easy / 15% light efforts",
  general_fitness: "80% easy / 20% moderate",
  recovery: "90% easy / 10% light efforts",
  maintenance: "80% easy / 15% moderate / 5% threshold",
};

// ============================================================================
// VOLUME TIER DEFINITIONS
// ============================================================================

export interface VolumeTierInfo {
  hours: string;
  sessions: string;
  distance: string;
}

export const VOLUME_TIERS: Record<VolumeTier, VolumeTierInfo> = {
  low: { hours: "4-6 hours/week", sessions: "3 rides", distance: "100-150 km" },
  medium: {
    hours: "7-10 hours/week",
    sessions: "4-5 rides",
    distance: "180-280 km",
  },
  high: {
    hours: "11-15 hours/week",
    sessions: "5-6 rides",
    distance: "300-450 km",
  },
};

export interface VolumeTierMapping {
  hoursPerWeek: { min: number; max: number };
  sessionsPerWeek: { min: number; max: number };
}

export const VOLUME_TIER_MAPPING: Record<VolumeTier, VolumeTierMapping> = {
  low: {
    hoursPerWeek: { min: 4, max: 6 },
    sessionsPerWeek: { min: 3, max: 3 },
  },
  medium: {
    hoursPerWeek: { min: 7, max: 10 },
    sessionsPerWeek: { min: 4, max: 5 },
  },
  high: {
    hoursPerWeek: { min: 11, max: 15 },
    sessionsPerWeek: { min: 5, max: 6 },
  },
};

// ============================================================================
// MODEL SELECTION
// ============================================================================

/**
 * Select periodization model based on athlete profile.
 *
 * - beginner → linear (simplest progression)
 * - <8 weeks available → reverse_linear (prioritize intensity early)
 * - advanced/elite + high volume → polarized
 * - intermediate + race goal → block (concentrated loading)
 * - fallback → pyramidal (versatile)
 */
export function selectPeriodizationModel(
  profile: AthleteProfile,
  totalWeeks: number,
): PeriodizationModel {
  if (profile.experienceLevel === "beginner") return "linear";
  if (totalWeeks <= 8) return "reverse_linear";
  if (
    (profile.experienceLevel === "advanced" || profile.experienceLevel === "elite") &&
    profile.volumeTier === "high"
  ) {
    return "polarized";
  }
  if (profile.experienceLevel === "intermediate" && profile.goalType === "race") {
    return "block";
  }
  return "pyramidal";
}

/**
 * Compute total plan duration in weeks.
 *
 * - Race + date: ceil(daysUntil / 7), clamped 8-24
 * - Race + no date: lookup by race type
 * - General: lookup by experience
 *
 * `tz` (IANA, default "UTC") frames "today" and the race date as local-midnight
 * to local-midnight, so the count doesn't drift by a day at TZ boundaries.
 */
export function computeTotalWeeks(profile: AthleteProfile, tz: string = "UTC"): number {
  if (profile.goalType === "race" && profile.raceDate) {
    const daysUntil = daysBetweenLocal(todayInTZ(tz), profile.raceDate);
    const weeks = Math.ceil(daysUntil / 7);
    return Math.max(8, Math.min(24, weeks));
  }

  if (profile.goalType === "race" && profile.raceType) {
    return DEFAULT_TOTAL_WEEKS_BY_RACE[profile.raceType] ?? 12;
  }

  return DEFAULT_TOTAL_WEEKS_BY_EXPERIENCE[profile.experienceLevel];
}

function todayInTZ(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Whole-day diff between two YYYY-MM-DD strings. Date.UTC ignores DST, so this
 * is exact for calendar-day arithmetic regardless of timezone.
 */
function daysBetweenLocal(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return Math.ceil(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / (1000 * 60 * 60 * 24),
  );
}
