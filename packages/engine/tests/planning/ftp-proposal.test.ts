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

type Evidence = "none" | "test-1" | "test-2" | "drift" | "one-ride";

interface World {
  readonly icu: number;
  readonly today: number;
  readonly proposal: FtpProposal;
  readonly evidence: Evidence;
  readonly checked: "checked" | "not-checked";
  readonly confirmShowed: number | "none";
  readonly answered: readonly string[];
  readonly lostIcu: boolean;
  readonly askedAgain: boolean;
}

function engineEvidence(evidence: Evidence): FtpEvidence {
  if (evidence === "test-1" || evidence === "test-2") {
    return { kind: "planned-test", watts: PROPOSED, activityId: evidence };
  }
  if (evidence === "drift") return { kind: "drift", watts: PROPOSED };
  return { kind: "none" };
}

function step(world: World, event: FtpProposalEvent): World {
  const result = ftpProposalStep(world.proposal, event);
  const next: World = { ...world, proposal: result.proposal };
  return result.proposal.kind === "confirming"
    ? { ...next, confirmShowed: result.proposal.icuWattsShown ?? "none" }
    : next;
}

function answer(world: World): World {
  const { proposal } = world;
  if (proposal.kind === "quiet" || proposal.basis.kind !== "planned-test") return world;
  return {
    ...world,
    answered: [...new Set([...world.answered, proposal.basis.activityId])].sort(),
  };
}

function appWrites(world: World): World {
  if (world.proposal.kind !== "writing") return world;
  if (world.icu !== world.proposal.expectedIcuWatts) {
    return step(world, { type: "write-refused", icuWattsNow: world.icu });
  }
  return {
    ...step(answer(world), { type: "write-finished" }),
    lostIcu: world.lostIcu || world.icu !== world.confirmShowed,
    icu: world.proposal.watts,
  };
}

function appChecks(world: World): World {
  const checked = step(world, {
    type: "checked",
    evidence: engineEvidence(world.evidence),
    todayDateKey: world.today,
  });
  const shownTest =
    checked.proposal.kind === "shown" && checked.proposal.basis.kind === "planned-test"
      ? checked.proposal.basis.activityId
      : null;
  return {
    ...checked,
    checked: "checked",
    evidence: world.evidence === "one-ride" ? "none" : world.evidence,
    askedAgain:
      world.askedAgain ||
      (world.proposal.kind === "quiet" && shownTest !== null && world.answered.includes(shownTest)),
  };
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [];
  if (world.proposal.kind === "quiet") {
    for (const evidence of ["test-1", "test-2", "drift", "one-ride"] as const) {
      const olderTest = evidence === "test-1" && world.answered.includes("test-2");
      if (evidence !== world.evidence && !olderTest) {
        steps.push([
          `evidence arrives: ${evidence}`,
          { ...world, evidence, checked: "not-checked" },
        ]);
      }
    }
  }
  if (world.checked === "not-checked")
    steps.push(["the app checks after a sync", appChecks(world)]);
  if (world.proposal.kind === "shown") {
    steps.push([
      "the athlete presses Keep",
      {
        ...step(answer(world), { type: "athlete-keeps", todayDateKey: world.today }),
        checked: "not-checked",
      },
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
    steps.push(["the write runs", { ...appWrites(world), checked: "not-checked" }]);
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

function testIsOpen(world: World): boolean {
  return (
    (world.evidence === "test-1" || world.evidence === "test-2") &&
    !world.answered.includes(world.evidence)
  );
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
    world.proposal.kind === "quiet" || world.evidence !== "one-ride",
  PlannedTestIsAnswered: (world: World) =>
    !(world.checked === "checked" && testIsOpen(world)) || world.proposal.kind !== "quiet",
  AnsweredTestIsNotAskedAgain: (world: World) => !world.askedAgain,
};

const START: World = {
  icu: ICU_NOW,
  today: TODAY,
  proposal: FTP_PROPOSAL_START,
  evidence: "none",
  checked: "checked",
  confirmShowed: "none",
  answered: [],
  lostIcu: false,
  askedAgain: false,
};

function shownFor(evidence: Evidence, today = TODAY): World {
  return step(START, { type: "checked", evidence: engineEvidence(evidence), todayDateKey: today });
}

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
    expect(result.states).toBeGreaterThan(200);
  });

  it("shows a number set in intervals.icu while the confirm is open before writing", () => {
    const confirming = step(shownFor("test-1"), { type: "athlete-uses", icuWatts: ICU_NOW });
    const confirmed = ftpProposalStep(confirming.proposal, {
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
    const kept = step(shownFor("drift"), { type: "athlete-keeps", todayDateKey: TODAY });
    const inside = addCivilDays(TODAY, 10);
    expect(
      ftpProposalStep(kept.proposal, {
        type: "checked",
        evidence: engineEvidence("test-1"),
        todayDateKey: inside,
      }).proposal,
    ).toMatchObject({ kind: "shown", basis: { kind: "planned-test", activityId: "test-1" } });
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
    ).toMatchObject({ kind: "shown", basis: { kind: "drift" } });
  });

  it("does not ask again about a planned test the athlete already answered", () => {
    const kept = step(shownFor("test-1"), { type: "athlete-keeps", todayDateKey: TODAY });
    const later = addCivilDays(TODAY, 2);
    expect(
      ftpProposalStep(kept.proposal, {
        type: "checked",
        evidence: engineEvidence("test-1"),
        todayDateKey: later,
      }).proposal,
    ).toMatchObject({ kind: "quiet" });
    expect(
      ftpProposalStep(kept.proposal, {
        type: "checked",
        evidence: engineEvidence("test-2"),
        todayDateKey: later,
      }).proposal,
    ).toMatchObject({ kind: "shown", basis: { activityId: "test-2" } });
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

  it("finds drift only after 14 days at least 3% away since the FTP was set", () => {
    const daily = (days: number, watts: number) =>
      Array.from({ length: days }, (_, offset) => ({
        dateKey: addCivilDays(TODAY, offset - days + 1),
        estimatedFtpWatts: watts,
      }));
    const longAgo = addCivilDays(TODAY, -100);
    const drift = (samples: ReturnType<typeof daily>, ftpSetDateKey = longAgo) =>
      ftpDriftEvidence({ ftpWatts: 282, ftpSetDateKey, samples, todayDateKey: TODAY });
    expect(drift(daily(14, 291))).toEqual({ kind: "drift", watts: 291 });
    expect(drift(daily(13, 291))).toEqual({ kind: "none" });
    expect(drift(daily(20, 289))).toEqual({ kind: "none" });
    expect(drift(daily(20, 270))).toEqual({ kind: "drift", watts: 270 });
    const broken = [...daily(20, 291)];
    broken[12] = { dateKey: broken[12]?.dateKey ?? TODAY, estimatedFtpWatts: 283 };
    expect(drift(broken)).toEqual({ kind: "none" });
    expect(drift([{ dateKey: addCivilDays(TODAY, -24), estimatedFtpWatts: 320 }])).toEqual({
      kind: "none",
    });
    expect(drift(daily(20, 291), addCivilDays(TODAY, -5))).toEqual({ kind: "none" });
  });
});
