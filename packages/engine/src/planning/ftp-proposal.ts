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
  | {
      readonly kind: "planned-test";
      readonly watts: number;
      readonly activityId: string;
      readonly dateKey: number;
    }
  | { readonly kind: "drift"; readonly watts: number }
  | { readonly kind: "none" };

export type FtpDriftPause =
  | { readonly kind: "none" }
  | { readonly kind: "until"; readonly dateKey: number };

export type FtpAnsweredTest =
  | { readonly kind: "none" }
  | { readonly kind: "answered"; readonly activityId: string; readonly dateKey: number };

export type FtpSeen =
  | { readonly kind: "none" }
  | { readonly kind: "seen"; readonly watts: number; readonly sinceDateKey: number };

export interface FtpMemory {
  readonly pause: FtpDriftPause;
  readonly answeredTest: FtpAnsweredTest;
  readonly ftpSeen: FtpSeen;
}

export type FtpProposalBasis =
  | { readonly kind: "planned-test"; readonly activityId: string; readonly dateKey: number }
  | { readonly kind: "drift" };

export type FtpProposal =
  | { readonly kind: "quiet"; readonly memory: FtpMemory }
  | {
      readonly kind: "shown";
      readonly watts: number;
      readonly basis: FtpProposalBasis;
      readonly memory: FtpMemory;
    }
  | {
      readonly kind: "confirming";
      readonly watts: number;
      readonly basis: FtpProposalBasis;
      readonly icuWattsShown: number | null;
      readonly memory: FtpMemory;
    }
  | {
      readonly kind: "writing";
      readonly watts: number;
      readonly basis: FtpProposalBasis;
      readonly expectedIcuWatts: number | null;
      readonly memory: FtpMemory;
    };

export type FtpProposalEvent =
  | {
      readonly type: "checked";
      readonly evidence: FtpEvidence;
      readonly icuFtpWatts: number | null;
      readonly todayDateKey: number;
    }
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
  memory: Object.freeze({
    pause: Object.freeze({ kind: "none" }),
    answeredTest: Object.freeze({ kind: "none" }),
    ftpSeen: Object.freeze({ kind: "none" }),
  }),
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
  readonly ftpSetDateKey: number;
  readonly samples: readonly FtpEstimateSample[];
  readonly todayDateKey: number;
}): FtpEvidence {
  const sorted = input.samples
    .filter(
      (sample) => sample.dateKey > input.ftpSetDateKey && sample.dateKey <= input.todayDateKey,
    )
    .sort((left, right) => left.dateKey - right.dateKey);
  const last = sorted.at(-1);
  if (last === undefined) return { kind: "none" };
  const side = driftSide(input.ftpWatts, last.estimatedFtpWatts);
  if (side === "near") return { kind: "none" };
  const run: FtpEstimateSample[] = [];
  for (const sample of [...sorted].reverse()) {
    if (driftSide(input.ftpWatts, sample.estimatedFtpWatts) !== side) break;
    run.push(sample);
  }
  const first = run.at(-1);
  if (first === undefined || run.length < 2) return { kind: "none" };
  if (addCivilDays(first.dateKey, FTP_DRIFT_DAYS - 1) > last.dateKey) return { kind: "none" };
  return { kind: "drift", watts: Math.round(last.estimatedFtpWatts) };
}

function pauseCovers(pause: FtpDriftPause, todayDateKey: number): boolean {
  return pause.kind === "until" && todayDateKey < pause.dateKey;
}

function stay(proposal: FtpProposal): FtpProposalStep {
  return { proposal, effect: NONE };
}

function seenFtp(seen: FtpSeen, watts: number | null, todayDateKey: number): FtpSeen {
  if (watts === null) return { kind: "none" };
  if (seen.kind === "seen" && seen.watts === watts) return seen;
  return { kind: "seen", watts, sinceDateKey: todayDateKey };
}

function alreadyAnswered(answered: FtpAnsweredTest, activityId: string, dateKey: number): boolean {
  return (
    answered.kind === "answered" &&
    (answered.activityId === activityId || dateKey < answered.dateKey)
  );
}

function onChecked(
  proposal: FtpProposal,
  event: Extract<FtpProposalEvent, { type: "checked" }>,
): FtpProposalStep {
  if (proposal.kind !== "quiet") return stay(proposal);
  const current = proposal.memory;
  const memory: FtpMemory = {
    ...current,
    pause: pauseCovers(current.pause, event.todayDateKey) ? current.pause : { kind: "none" },
    ftpSeen: seenFtp(current.ftpSeen, event.icuFtpWatts, event.todayDateKey),
  };
  const evidence = event.evidence;
  if (evidence.kind === "planned-test") {
    if (alreadyAnswered(memory.answeredTest, evidence.activityId, evidence.dateKey)) {
      return stay({ kind: "quiet", memory });
    }
    return stay({
      kind: "shown",
      watts: evidence.watts,
      basis: { kind: "planned-test", activityId: evidence.activityId, dateKey: evidence.dateKey },
      memory,
    });
  }
  if (evidence.kind === "drift" && memory.pause.kind === "none") {
    return stay({ kind: "shown", watts: evidence.watts, basis: { kind: "drift" }, memory });
  }
  return stay({ kind: "quiet", memory });
}

function answeredMemory(memory: FtpMemory, basis: FtpProposalBasis): FtpMemory {
  return basis.kind === "planned-test"
    ? {
        ...memory,
        answeredTest: { kind: "answered", activityId: basis.activityId, dateKey: basis.dateKey },
      }
    : memory;
}

export function ftpProposalStep(proposal: FtpProposal, event: FtpProposalEvent): FtpProposalStep {
  switch (event.type) {
    case "checked":
      return onChecked(proposal, event);
    case "athlete-keeps":
      if (proposal.kind !== "shown") return stay(proposal);
      return stay({
        kind: "quiet",
        memory: {
          ...answeredMemory(proposal.memory, proposal.basis),
          pause: { kind: "until", dateKey: addCivilDays(event.todayDateKey, FTP_KEEP_PAUSE_DAYS) },
        },
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
          basis: proposal.basis,
          expectedIcuWatts: proposal.icuWattsShown,
          memory: proposal.memory,
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
        basis: proposal.basis,
        memory: proposal.memory,
      });
    case "write-finished":
      return proposal.kind === "writing"
        ? stay({ kind: "quiet", memory: answeredMemory(proposal.memory, proposal.basis) })
        : stay(proposal);
    case "write-failed":
      if (proposal.kind !== "writing") return stay(proposal);
      return stay({
        kind: "shown",
        watts: proposal.watts,
        basis: proposal.basis,
        memory: proposal.memory,
      });
    case "write-refused":
      if (proposal.kind !== "writing") return stay(proposal);
      return stay({
        kind: "confirming",
        watts: proposal.watts,
        basis: proposal.basis,
        icuWattsShown: event.icuWattsNow,
        memory: proposal.memory,
      });
  }
}

export function ftpSetSince(memory: FtpMemory, fallbackDateKey: number): number {
  return memory.ftpSeen.kind === "seen" ? memory.ftpSeen.sinceDateKey : fallbackDateKey;
}
