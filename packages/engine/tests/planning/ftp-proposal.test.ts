import { describe, expect, it } from "vitest";
import { addCivilDays } from "@enduragent/kernel/planning";
import {
  coachFtp,
  ftpDriftEvidence,
  ftpProposalStep,
  FTP_PROPOSAL_START,
  type FtpEvidence,
  type FtpProposal,
  type FtpProposalEvent,
} from "../../src/planning/ftp-proposal.js";
import { walk, type Step } from "./state-walk.js";

const TODAY = 19980810;
const ICU_NOW = 282;
const PROPOSED = 288;
const ATHLETE_SET = 285;

type Evidence = "none" | "test" | "drift" | "one-ride";

interface World {
  readonly icu: number;
  readonly today: number;
  readonly proposal: FtpProposal;
  readonly evidence: Evidence;
  readonly checked: "checked" | "not-checked";
  readonly confirmShowed: number | "none";
  readonly lostIcu: boolean;
}

function engineEvidence(evidence: Evidence): FtpEvidence {
  if (evidence === "test") return { kind: "planned-test", watts: PROPOSED, activityId: "a1" };
  if (evidence === "drift") return { kind: "drift", watts: PROPOSED };
  return { kind: "none" };
}

function step(world: World, event: FtpProposalEvent): World {
  const result = ftpProposalStep(world.proposal, event);
  let next: World = { ...world, proposal: result.proposal };
  if (result.proposal.kind === "confirming") {
    next = { ...next, confirmShowed: result.proposal.icuWattsShown ?? "none" };
  }
  return next;
}

function appWrites(world: World): World {
  if (world.proposal.kind !== "writing") return world;
  if (world.icu !== world.proposal.expectedIcuWatts) {
    return step(world, { type: "write-refused", icuWattsNow: world.icu });
  }
  return {
    ...step(world, { type: "write-finished" }),
    lostIcu: world.lostIcu || world.icu !== world.confirmShowed,
    icu: world.proposal.watts,
    evidence: "none",
  };
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [];
  if (world.evidence === "none" && world.proposal.kind === "quiet") {
    for (const evidence of ["test", "drift", "one-ride"] as const) {
      steps.push([`evidence arrives: ${evidence}`, { ...world, evidence, checked: "not-checked" }]);
    }
  }
  if (world.checked === "not-checked") {
    const checked = step(world, {
      type: "checked",
      evidence: engineEvidence(world.evidence),
      todayDateKey: world.today,
    });
    steps.push([
      "the app checks after a sync",
      {
        ...checked,
        checked: "checked",
        evidence: world.evidence === "one-ride" ? "none" : world.evidence,
      },
    ]);
  }
  if (world.proposal.kind === "shown") {
    steps.push([
      "the athlete presses Keep",
      { ...step(world, { type: "athlete-keeps", todayDateKey: world.today }), evidence: "none" },
    ]);
    steps.push([
      "the athlete presses Use",
      step(world, { type: "athlete-uses", icuWatts: world.icu }),
    ]);
  }
  if (world.proposal.kind === "confirming") {
    steps.push([
      "the athlete confirms",
      step(world, { type: "athlete-confirms", icuWattsNow: world.icu }),
    ]);
    steps.push(["the athlete cancels", step(world, { type: "athlete-cancels" })]);
  }
  if (world.proposal.kind === "writing") {
    steps.push(["the write runs", appWrites(world)]);
    steps.push(["intervals.icu does not answer", step(world, { type: "write-failed" })]);
  }
  if (world.icu !== ATHLETE_SET) {
    steps.push(["the athlete sets FTP in intervals.icu", { ...world, icu: ATHLETE_SET }]);
  }
  steps.push([
    "four weeks pass",
    { ...world, today: addCivilDays(world.today, 28), checked: "not-checked" },
  ]);
  return steps;
}

const RULES = {
  OneFtp: (world: World) => {
    const used = coachFtp(
      { ftpWatts: world.icu, indoorFtpWatts: null, estimatedFtpWatts: 300 },
      "outdoor",
    );
    return used.kind === "set" && used.watts === world.icu;
  },
  NeverOverwriteAnUnseenFtp: (world: World) => !world.lostIcu,
  NoProposalFromOneRide: (world: World) =>
    world.proposal.kind === "quiet" || world.evidence === "test" || world.evidence === "drift",
  PlannedTestIsAnswered: (world: World) =>
    !(world.checked === "checked" && world.evidence === "test") || world.proposal.kind !== "quiet",
};

const START: World = {
  icu: ICU_NOW,
  today: TODAY,
  proposal: FTP_PROPOSAL_START,
  evidence: "none",
  checked: "checked",
  confirmShowed: "none",
  lostIcu: false,
};

describe("FTP", () => {
  it("keeps every rule on every path of up to nine steps", () => {
    const result = walk({
      initial: [START],
      next,
      key: (world) =>
        JSON.stringify({ ...world, today: world.today > TODAY + 200 ? "late" : world.today }),
      rules: RULES,
      maxDepth: 9,
    });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(50);
  });

  it("shows a number set in intervals.icu while the confirm is open before writing", () => {
    const shown = step(START, {
      type: "checked",
      evidence: engineEvidence("test"),
      todayDateKey: TODAY,
    });
    const confirming = step(shown, { type: "athlete-uses", icuWatts: ICU_NOW });
    const changedThere = { ...confirming, icu: ATHLETE_SET };
    const confirmed = ftpProposalStep(changedThere.proposal, {
      type: "athlete-confirms",
      icuWattsNow: ATHLETE_SET,
    });
    expect(confirmed.effect).toEqual({ kind: "none" });
    expect(confirmed.proposal).toMatchObject({ kind: "confirming", icuWattsShown: ATHLETE_SET });
    const again = ftpProposalStep(confirmed.proposal, {
      type: "athlete-confirms",
      icuWattsNow: ATHLETE_SET,
    });
    expect(again.effect).toEqual({
      kind: "write-ftp",
      watts: PROPOSED,
      expectedIcuWatts: ATHLETE_SET,
    });
  });

  it("answers a planned test within four weeks of Keep", () => {
    const shown = step(START, {
      type: "checked",
      evidence: engineEvidence("test"),
      todayDateKey: TODAY,
    });
    const kept = step(shown, { type: "athlete-keeps", todayDateKey: TODAY });
    const inside = addCivilDays(TODAY, 10);
    expect(
      ftpProposalStep(kept.proposal, {
        type: "checked",
        evidence: engineEvidence("test"),
        todayDateKey: inside,
      }).proposal,
    ).toMatchObject({ kind: "shown", evidence: "planned-test" });
    expect(
      ftpProposalStep(kept.proposal, {
        type: "checked",
        evidence: engineEvidence("drift"),
        todayDateKey: inside,
      }).proposal,
    ).toMatchObject({ kind: "quiet" });
    expect(
      ftpProposalStep(kept.proposal, {
        type: "checked",
        evidence: engineEvidence("drift"),
        todayDateKey: addCivilDays(TODAY, 28),
      }).proposal,
    ).toMatchObject({ kind: "shown", evidence: "drift" });
  });

  it("uses only intervals.icu's FTP, the indoor one for indoor rides", () => {
    const settings = { ftpWatts: 282, indoorFtpWatts: 274, estimatedFtpWatts: 276 };
    expect(coachFtp(settings, "outdoor")).toEqual({ kind: "set", watts: 282, use: "outdoor" });
    expect(coachFtp(settings, "indoor")).toEqual({ kind: "set", watts: 274, use: "indoor" });
    expect(coachFtp({ ...settings, indoorFtpWatts: null }, "indoor")).toEqual({
      kind: "set",
      watts: 282,
      use: "outdoor",
    });
    expect(
      coachFtp({ ftpWatts: null, indoorFtpWatts: null, estimatedFtpWatts: 276 }, "outdoor"),
    ).toEqual({
      kind: "estimate-only",
      estimatedWatts: 276,
    });
    expect(
      coachFtp({ ftpWatts: null, indoorFtpWatts: null, estimatedFtpWatts: null }, "outdoor"),
    ).toEqual({ kind: "none" });
  });

  it("finds drift only after 14 days at least 3% away", () => {
    const daily = (days: number, watts: number) =>
      Array.from({ length: days }, (_, offset) => ({
        dateKey: addCivilDays(TODAY, offset - days + 1),
        estimatedFtpWatts: watts,
      }));
    expect(
      ftpDriftEvidence({ ftpWatts: 282, samples: daily(14, 291), todayDateKey: TODAY }),
    ).toEqual({
      kind: "drift",
      watts: 291,
    });
    expect(
      ftpDriftEvidence({ ftpWatts: 282, samples: daily(13, 291), todayDateKey: TODAY }),
    ).toEqual({ kind: "none" });
    expect(
      ftpDriftEvidence({ ftpWatts: 282, samples: daily(20, 289), todayDateKey: TODAY }),
    ).toEqual({ kind: "none" });
    expect(
      ftpDriftEvidence({ ftpWatts: 282, samples: daily(20, 270), todayDateKey: TODAY }),
    ).toEqual({
      kind: "drift",
      watts: 270,
    });
    const broken = [...daily(20, 291)];
    broken[12] = { dateKey: broken[12]?.dateKey ?? TODAY, estimatedFtpWatts: 283 };
    expect(ftpDriftEvidence({ ftpWatts: 282, samples: broken, todayDateKey: TODAY })).toEqual({
      kind: "none",
    });
    expect(
      ftpDriftEvidence({
        ftpWatts: 282,
        samples: [{ dateKey: TODAY, estimatedFtpWatts: 320 }],
        todayDateKey: TODAY,
      }),
    ).toEqual({
      kind: "none",
    });
  });
});
