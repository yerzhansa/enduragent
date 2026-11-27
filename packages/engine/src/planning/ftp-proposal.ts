import { addCivilDays } from "@enduragent/kernel/planning";

export const FTP_DRIFT_RATIO = 0.03;
export const FTP_DRIFT_DAYS = 14;
export const FTP_KEEP_PAUSE_DAYS = 28;

export interface IcuSportFtp {
  readonly ftpWatts: number | null;
  readonly indoorFtpWatts: number | null;
  readonly estimatedFtpWatts: number | null;
}

export type CoachFtp =
  | { readonly kind: "set"; readonly watts: number; readonly use: "outdoor" | "indoor" }
  | { readonly kind: "estimate-only"; readonly estimatedWatts: number }
  | { readonly kind: "none" };

export type FtpEvidence =
  | { readonly kind: "planned-test"; readonly watts: number; readonly activityId: string }
  | { readonly kind: "drift"; readonly watts: number }
  | { readonly kind: "none" };

export type FtpDriftPause =
  | { readonly kind: "none" }
  | { readonly kind: "until"; readonly dateKey: number };

export type FtpProposal =
  | { readonly kind: "quiet"; readonly pause: FtpDriftPause }
  | {
      readonly kind: "shown";
      readonly watts: number;
      readonly evidence: "planned-test" | "drift";
      readonly pause: FtpDriftPause;
    }
  | {
      readonly kind: "confirming";
      readonly watts: number;
      readonly evidence: "planned-test" | "drift";
      readonly icuWattsShown: number | null;
      readonly pause: FtpDriftPause;
    }
  | {
      readonly kind: "writing";
      readonly watts: number;
      readonly evidence: "planned-test" | "drift";
      readonly expectedIcuWatts: number | null;
      readonly pause: FtpDriftPause;
    };

export type FtpProposalEvent =
  | { readonly type: "checked"; readonly evidence: FtpEvidence; readonly todayDateKey: number }
  | { readonly type: "athlete-keeps"; readonly todayDateKey: number }
  | { readonly type: "athlete-uses"; readonly icuWatts: number | null }
  | { readonly type: "athlete-confirms"; readonly icuWattsNow: number | null }
  | { readonly type: "athlete-cancels" }
  | { readonly type: "write-finished" }
  | { readonly type: "write-failed" }
  | { readonly type: "write-refused"; readonly icuWattsNow: number | null };

export type FtpProposalEffect =
  | { readonly kind: "none" }
  | {
      readonly kind: "write-ftp";
      readonly watts: number;
      readonly expectedIcuWatts: number | null;
    };

export interface FtpProposalStep {
  readonly proposal: FtpProposal;
  readonly effect: FtpProposalEffect;
}

export interface FtpEstimateSample {
  readonly dateKey: number;
  readonly estimatedFtpWatts: number;
}

export const FTP_PROPOSAL_START: FtpProposal = Object.freeze({
  kind: "quiet",
  pause: Object.freeze({ kind: "none" }),
});

const NONE: FtpProposalEffect = Object.freeze({ kind: "none" });

export function coachFtp(settings: IcuSportFtp, ride: "outdoor" | "indoor"): CoachFtp {
  if (ride === "indoor" && settings.indoorFtpWatts !== null) {
    return { kind: "set", watts: settings.indoorFtpWatts, use: "indoor" };
  }
  if (settings.ftpWatts !== null) return { kind: "set", watts: settings.ftpWatts, use: "outdoor" };
  if (settings.estimatedFtpWatts !== null) {
    return { kind: "estimate-only", estimatedWatts: settings.estimatedFtpWatts };
  }
  return { kind: "none" };
}

type DriftSide = "above" | "below" | "near";

function driftSide(ftpWatts: number, estimateWatts: number): DriftSide {
  const limit = ftpWatts * FTP_DRIFT_RATIO;
  if (estimateWatts - ftpWatts >= limit) return "above";
  if (ftpWatts - estimateWatts >= limit) return "below";
  return "near";
}

export function ftpDriftEvidence(input: {
  readonly ftpWatts: number;
  readonly samples: readonly FtpEstimateSample[];
  readonly todayDateKey: number;
}): FtpEvidence {
  const sorted = input.samples
    .filter((sample) => sample.dateKey <= input.todayDateKey)
    .sort((left, right) => left.dateKey - right.dateKey);
  const last = sorted.at(-1);
  if (last === undefined) return { kind: "none" };
  const side = driftSide(input.ftpWatts, last.estimatedFtpWatts);
  if (side === "near") return { kind: "none" };
  let runStartDateKey = last.dateKey;
  for (const sample of [...sorted].reverse()) {
    if (driftSide(input.ftpWatts, sample.estimatedFtpWatts) !== side) break;
    runStartDateKey = sample.dateKey;
  }
  if (runStartDateKey > addCivilDays(input.todayDateKey, -(FTP_DRIFT_DAYS - 1))) {
    return { kind: "none" };
  }
  return { kind: "drift", watts: Math.round(last.estimatedFtpWatts) };
}

function pauseCovers(pause: FtpDriftPause, todayDateKey: number): boolean {
  return pause.kind === "until" && todayDateKey < pause.dateKey;
}

function stay(proposal: FtpProposal): FtpProposalStep {
  return { proposal, effect: NONE };
}

function onChecked(
  proposal: FtpProposal,
  event: Extract<FtpProposalEvent, { type: "checked" }>,
): FtpProposalStep {
  if (proposal.kind !== "quiet") return stay(proposal);
  const pause = pauseCovers(proposal.pause, event.todayDateKey)
    ? proposal.pause
    : ({ kind: "none" } as const);
  if (event.evidence.kind === "planned-test") {
    return stay({ kind: "shown", watts: event.evidence.watts, evidence: "planned-test", pause });
  }
  if (event.evidence.kind === "drift" && pause.kind === "none") {
    return stay({ kind: "shown", watts: event.evidence.watts, evidence: "drift", pause });
  }
  return stay({ kind: "quiet", pause });
}

export function ftpProposalStep(proposal: FtpProposal, event: FtpProposalEvent): FtpProposalStep {
  switch (event.type) {
    case "checked":
      return onChecked(proposal, event);
    case "athlete-keeps":
      if (proposal.kind !== "shown") return stay(proposal);
      return stay({
        kind: "quiet",
        pause: { kind: "until", dateKey: addCivilDays(event.todayDateKey, FTP_KEEP_PAUSE_DAYS) },
      });
    case "athlete-uses":
      if (proposal.kind !== "shown") return stay(proposal);
      return stay({ ...proposal, kind: "confirming", icuWattsShown: event.icuWatts });
    case "athlete-confirms":
      if (proposal.kind !== "confirming") return stay(proposal);
      if (event.icuWattsNow !== proposal.icuWattsShown) {
        return stay({ ...proposal, icuWattsShown: event.icuWattsNow });
      }
      return {
        proposal: {
          kind: "writing",
          watts: proposal.watts,
          evidence: proposal.evidence,
          expectedIcuWatts: proposal.icuWattsShown,
          pause: proposal.pause,
        },
        effect: {
          kind: "write-ftp",
          watts: proposal.watts,
          expectedIcuWatts: proposal.icuWattsShown,
        },
      };
    case "athlete-cancels":
      if (proposal.kind !== "confirming") return stay(proposal);
      return stay({
        kind: "shown",
        watts: proposal.watts,
        evidence: proposal.evidence,
        pause: proposal.pause,
      });
    case "write-finished":
      return proposal.kind === "writing"
        ? stay({ kind: "quiet", pause: proposal.pause })
        : stay(proposal);
    case "write-failed":
      if (proposal.kind !== "writing") return stay(proposal);
      return stay({
        kind: "shown",
        watts: proposal.watts,
        evidence: proposal.evidence,
        pause: proposal.pause,
      });
    case "write-refused":
      if (proposal.kind !== "writing") return stay(proposal);
      return stay({
        kind: "confirming",
        watts: proposal.watts,
        evidence: proposal.evidence,
        icuWattsShown: event.icuWattsNow,
        pause: proposal.pause,
      });
  }
}
